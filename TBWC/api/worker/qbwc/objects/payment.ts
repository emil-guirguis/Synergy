/**
 * Payment pull (QB ReceivePayment -> qb_payment). Incremental via FromModifiedDate.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, refField, qbTimeToTs, qbDate, num, txnModifiedFilter,
} from '../qbxml';
import { sinceModified } from '../incremental';

const REQUEST_ID = 'payment';

async function buildRequest(env: Env): Promise<string> {
  const filter = txnModifiedFilter(await sinceModified(env, 'qb_payment', 'qbwc.payment.since'));
  return qbxmlDoc(`    <ReceivePaymentQueryRq requestID="${REQUEST_ID}">${filter}\n    </ReceivePaymentQueryRq>`);
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'ReceivePaymentQueryRs');
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] ReceivePaymentQueryRs status', status);
    return;
  }
  const rets = blocks(xml, 'ReceivePaymentRet');
  console.log(`[QBWC] ReceivePaymentQueryRs: ${rets.length} payment(s)`);

  for (const ret of rets) {
    const txnId = tag(ret, 'TxnID');
    if (!txnId) continue;
    const cust = refField(ret, 'CustomerRef');
    await execQuery(
      env,
      `INSERT INTO public.qb_payment
         (txn_id, edit_sequence, ref_number, customer_list_id, customer_name, txn_date,
          total_amount, time_modified, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (txn_id) DO UPDATE SET
         edit_sequence=EXCLUDED.edit_sequence, ref_number=EXCLUDED.ref_number,
         customer_list_id=EXCLUDED.customer_list_id, customer_name=EXCLUDED.customer_name,
         txn_date=EXCLUDED.txn_date, total_amount=EXCLUDED.total_amount,
         time_modified=EXCLUDED.time_modified, raw=EXCLUDED.raw, synced_at=CURRENT_TIMESTAMP`,
      [
        txnId,
        tag(ret, 'EditSequence') ?? null,
        tag(ret, 'RefNumber') ?? null,
        cust.listId ?? null,
        cust.fullName ?? null,
        qbDate(tag(ret, 'TxnDate')),
        num(tag(ret, 'TotalAmount')),
        qbTimeToTs(tag(ret, 'TimeModified')),
        JSON.stringify({ txnId, ret: ret.slice(0, 8000) }),
      ],
      'qbwc.payment.upsert'
    );
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (object_type, qb_list_id, qb_edit_sequence, last_synced_at)
       VALUES ('Payment', $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence=EXCLUDED.qb_edit_sequence, last_synced_at=CURRENT_TIMESTAMP`,
      [txnId, tag(ret, 'EditSequence') ?? null],
      'qbwc.payment.map'
    );
  }
}

const payment: QbObject = { name: 'Payment', requestID: REQUEST_ID, buildRequest, parseResponse };
export default payment;
