/**
 * Invoice pull (QB -> qb_invoice). Incremental via FromModifiedDate. Lines are
 * flattened into a jsonb array; header customer ref + totals into columns.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, refField, lineItems,
  qbTimeToTs, qbDate, num, txnModifiedFilter, QB_MAX_RETURNED,
} from '../qbxml';
import { refreshOrderInvoiceStatus } from '../orderInvoiceStatus';
import { sinceModified } from '../incremental';
import { getPullCursor } from '../pullCursor';
import { multiRowValues, chunk, BATCH_SIZE } from '../batchSql';

/** LinkedTxn blocks (header + per-line), deduped by TxnID — links this invoice
 *  back to the SalesOrder(s) it was created from. */
function linkedTxns(ret: string): { txn_id: string; txn_type: string | null }[] {
  const seen = new Map<string, { txn_id: string; txn_type: string | null }>();
  for (const b of blocks(ret, 'LinkedTxn')) {
    const id = tag(b, 'TxnID');
    if (id && !seen.has(id)) seen.set(id, { txn_id: id, txn_type: tag(b, 'TxnType') ?? null });
  }
  return [...seen.values()];
}

const REQUEST_ID = 'invoice';

async function buildRequest(env: Env): Promise<string> {
  // Trust qb_invoice's own MAX(time_modified) only once a prior pull's iterator
  // is confirmed fully drained. If the last sequence left more pages pending
  // (QB never reported iteratorRemainingCount=0, or a session died mid-Continue),
  // that MAX() already advanced past whatever backlog didn't get fetched -- using
  // it here would permanently skip those records. Fall back to the last
  // confirmed-safe point instead (see migration 025 / pullCursor.ts).
  const cursor = await getPullCursor(env, 'Invoice');
  const since = cursor.drainPending
    ? cursor.confirmedThrough
    : await sinceModified(env, 'qb_invoice', 'qbwc.invoice.since');
  const filter = txnModifiedFilter(since);
  // Paged via iterator, same as customer/item/salesOrder — without it QB caps
  // an un-iterated InvoiceQueryRq well short of the full result set (seen:
  // 187 back when the whole company file has far more invoices than that).
  // qbXML schema order: MaxReturned before the date filter, IncludeLineItems last.
  return qbxmlDoc(
    `    <InvoiceQueryRq requestID="${REQUEST_ID}" iterator="Start">\n` +
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>${filter}\n` +
    `      <IncludeLineItems>true</IncludeLineItems>\n` +
    `    </InvoiceQueryRq>`
  );
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'InvoiceQueryRs');
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] InvoiceQueryRs status', status);
    return;
  }
  const rets = blocks(xml, 'InvoiceRet');
  console.log(`[QBWC] InvoiceQueryRs: ${rets.length} invoice(s)`);

  // Dedupe by txn_id (last wins) — a duplicate key inside one multi-row upsert
  // makes Postgres error with "cannot affect row a second time".
  const byId = new Map<string, any[]>();
  for (const ret of rets) {
    const txnId = tag(ret, 'TxnID');
    if (!txnId) continue;
    const cust = refField(ret, 'CustomerRef');
    byId.set(txnId, [
      txnId,
      tag(ret, 'EditSequence') ?? null,
      tag(ret, 'RefNumber') ?? null,
      cust.listId ?? null,
      cust.fullName ?? null,
      qbDate(tag(ret, 'TxnDate')),
      qbDate(tag(ret, 'DueDate')),
      num(tag(ret, 'Subtotal')),
      // QB InvoiceRet has no Total element: total = Subtotal + SalesTaxTotal.
      (() => {
        const sub = num(tag(ret, 'Subtotal'));
        const taxV = num(tag(ret, 'SalesTaxTotal'));
        if (sub == null && taxV == null) return null;
        return (sub ?? 0) + (taxV ?? 0);
      })(),
      num(tag(ret, 'BalanceRemaining')),
      (() => { const b = num(tag(ret, 'BalanceRemaining')); return b == null ? null : b === 0; })(),
      JSON.stringify(lineItems(ret, 'InvoiceLineRet')),
      JSON.stringify(linkedTxns(ret)),
      qbTimeToTs(tag(ret, 'TimeModified')),
      JSON.stringify({ txnId, ret: ret.slice(0, 8000) }),
    ]);
  }

  // Batched multi-row upserts: execQuery opens a connection per call, so an
  // iterator page must be a handful of statements, not one per record (a
  // per-record loop was slow enough to blow the Web Connector's response
  // timeout mid-page, silently truncating large pulls).
  const CASTS = ['', '', '', '', '', '', '', '', '', '', '', '::jsonb', '::jsonb', '', '::jsonb'];
  for (const rows of chunk([...byId.values()], BATCH_SIZE)) {
    await execQuery(
      env,
      `INSERT INTO public.qb_invoice
         (txn_id, edit_sequence, ref_number, customer_list_id, customer_name, txn_date,
          due_date, subtotal, total, balance_remaining, is_paid, lines, linked_txn, time_modified, raw, synced_at)
       VALUES ${multiRowValues(rows.length, CASTS, ', CURRENT_TIMESTAMP')}
       ON CONFLICT (txn_id) DO UPDATE SET
         edit_sequence=EXCLUDED.edit_sequence, ref_number=EXCLUDED.ref_number,
         customer_list_id=EXCLUDED.customer_list_id, customer_name=EXCLUDED.customer_name,
         txn_date=EXCLUDED.txn_date, due_date=EXCLUDED.due_date, subtotal=EXCLUDED.subtotal,
         total=EXCLUDED.total, balance_remaining=EXCLUDED.balance_remaining, is_paid=EXCLUDED.is_paid,
         lines=EXCLUDED.lines, linked_txn=EXCLUDED.linked_txn, time_modified=EXCLUDED.time_modified,
         raw=EXCLUDED.raw, synced_at=CURRENT_TIMESTAMP`,
      rows.flat(),
      'qbwc.invoice.upsert'
    );
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (qb_list_id, qb_edit_sequence, object_type, last_synced_at)
       VALUES ${multiRowValues(rows.length, ['', ''], ", 'Invoice', CURRENT_TIMESTAMP")}
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence=EXCLUDED.qb_edit_sequence, last_synced_at=CURRENT_TIMESTAMP`,
      rows.flatMap((r) => [r[0], r[1]]),
      'qbwc.invoice.map'
    );
  }

  if (rets.length > 0) await refreshOrderInvoiceStatus(env);
}

const invoice: QbObject = {
  name: 'Invoice',
  requestID: REQUEST_ID,
  buildRequest,
  parseResponse,
  iteratorExtra: '      <IncludeLineItems>true</IncludeLineItems>\n',
};
export default invoice;
