/**
 * Payment pull (QB ReceivePayment -> qb_payment). The AR side of the sync:
 * what a customer paid, when, and which invoice(s) it was applied to.
 * Incremental via ModifiedDateRangeFilter, same cursor system as Invoice/SalesOrder.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, refField, qbTimeToTs, qbDate, num,
  txnModifiedFilter, QB_MAX_RETURNED,
} from '../qbxml';
import { pullSince } from '../incremental';
import { multiRowValues, chunk, BATCH_SIZE } from '../batchSql';

const REQUEST_ID = 'payment';

async function buildRequest(env: Env): Promise<string> {
  const filter = txnModifiedFilter(await pullSince(env, 'Payment', 'qb_payment', 'qbwc.payment.since'));
  // Paged via iterator, same as customer/item/salesOrder/invoice -- an
  // un-iterated ReceivePaymentQueryRq is capped well short of the full
  // result set once the company file has more payments than that cap.
  // IncludeLineItems is what makes QB emit AppliedToTxnRet blocks (which
  // invoice(s) this payment was applied to, and how much of each). Without
  // it QB omits them silently -- left applied_to as [] on every synced row,
  // so amount_for_order (routes/orders.ts) had nothing to sum and the order
  // panel showed no payments for orders whose invoices were fully paid this
  // way (e.g. TBWC 5455).
  return qbxmlDoc(
    `    <ReceivePaymentQueryRq requestID="${REQUEST_ID}" iterator="Start">\n` +
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>${filter}\n` +
    `      <IncludeLineItems>true</IncludeLineItems>\n` +
    `    </ReceivePaymentQueryRq>`
  );
}

/** AppliedToTxnRet blocks -- which invoice(s) this payment covers. */
function appliedToTxns(ret: string): { txn_id: string; txn_type: string | null; ref_number: string | null; amount: number | null }[] {
  return blocks(ret, 'AppliedToTxnRet')
    .map((b) => ({
      txn_id: tag(b, 'TxnID') ?? '',
      txn_type: tag(b, 'TxnType') ?? null,
      ref_number: tag(b, 'RefNumber') ?? null,
      amount: num(tag(b, 'Amount')),
    }))
    .filter((a) => a.txn_id);
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'ReceivePaymentQueryRs');
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] ReceivePaymentQueryRs status', status);
    return;
  }
  const rets = blocks(xml, 'ReceivePaymentRet');
  console.log(`[QBWC] ReceivePaymentQueryRs: ${rets.length} payment(s)`);

  // Dedupe by txn_id (last wins) -- a duplicate key inside one multi-row
  // upsert makes Postgres error with "cannot affect row a second time".
  const byId = new Map<string, any[]>();
  for (const ret of rets) {
    const txnId = tag(ret, 'TxnID');
    if (!txnId) continue;
    const cust = refField(ret, 'CustomerRef');
    const applied = appliedToTxns(ret);
    const totalAmount = num(tag(ret, 'TotalAmount'));
    const appliedSum = applied.reduce((sum, a) => sum + (a.amount ?? 0), 0);
    byId.set(txnId, [
      txnId,
      tag(ret, 'EditSequence') ?? null,
      tag(ret, 'RefNumber') ?? null,
      cust.listId ?? null,
      cust.fullName ?? null,
      qbDate(tag(ret, 'TxnDate')),
      totalAmount,
      JSON.stringify(applied),
      totalAmount == null ? null : totalAmount - appliedSum,
      qbTimeToTs(tag(ret, 'TimeModified')),
      JSON.stringify({ txnId, ret: ret.slice(0, 8000) }),
    ]);
  }

  // Batched multi-row upserts: execQuery opens a connection per call, so an
  // iterator page must be a handful of statements, not one per record.
  const CASTS = ['', '', '', '', '', '', '', '::jsonb', '', '', '::jsonb'];
  for (const rows of chunk([...byId.values()], BATCH_SIZE)) {
    await execQuery(
      env,
      `INSERT INTO public.qb_payment
         (txn_id, edit_sequence, ref_number, customer_list_id, customer_name, txn_date,
          total_amount, applied_to, unapplied_amount, time_modified, raw, synced_at)
       VALUES ${multiRowValues(rows.length, CASTS, ', CURRENT_TIMESTAMP')}
       ON CONFLICT (txn_id) DO UPDATE SET
         edit_sequence=EXCLUDED.edit_sequence, ref_number=EXCLUDED.ref_number,
         customer_list_id=EXCLUDED.customer_list_id, customer_name=EXCLUDED.customer_name,
         txn_date=EXCLUDED.txn_date, total_amount=EXCLUDED.total_amount,
         applied_to=EXCLUDED.applied_to, unapplied_amount=EXCLUDED.unapplied_amount,
         time_modified=EXCLUDED.time_modified, raw=EXCLUDED.raw, synced_at=CURRENT_TIMESTAMP`,
      rows.flat(),
      'qbwc.payment.upsert'
    );
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (qb_list_id, qb_edit_sequence, object_type, last_synced_at)
       VALUES ${multiRowValues(rows.length, ['', ''], ", 'Payment', CURRENT_TIMESTAMP")}
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence=EXCLUDED.qb_edit_sequence, last_synced_at=CURRENT_TIMESTAMP`,
      rows.flatMap((r) => [r[0], r[1]]),
      'qbwc.payment.map'
    );
  }
}

const payment: QbObject = {
  name: 'Payment',
  requestID: REQUEST_ID,
  buildRequest,
  parseResponse,
  iteratorExtra: '      <IncludeLineItems>true</IncludeLineItems>\n',
  incremental: true,
};
export default payment;
