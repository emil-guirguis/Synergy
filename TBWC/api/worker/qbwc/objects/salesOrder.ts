/**
 * SalesOrder pull (QB -> qb_sales_order). QB Premier/Enterprise only; on QB Pro
 * the QueryRq returns a statusCode we log and skip. Incremental via FromModifiedDate.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, refField, lineItems,
  qbTimeToTs, qbDate, num, txnModifiedFilter, QB_MAX_RETURNED,
  addrBlockText, dataExtBlocks, escapeXml, unescapeXml,
} from '../qbxml';
import { multiRowValues, chunk, BATCH_SIZE } from '../batchSql';
import { refreshOrderInvoiceStatus } from '../orderInvoiceStatus';
import { pullSince } from '../incremental';
import { pendingPushes, markPushed, markFailed, type PendingPush } from '../pushQueue';
import { logDetail } from '../syncLog';

const REQUEST_ID = 'salesorder';

// TBWC/schema field name (queued via routes/orders.ts's PUSHABLE) -> QB XML tag.
// Add an entry here (and to orders.ts's PUSHABLE) for each new pushable field —
// no migration needed, qbwc_push_queue is generic.
const FIELD_TO_QB_TAG: Record<string, string> = {
  memo: 'Memo',
};

// Column index of ref_number in the row rowFromRet() builds (txn_id,
// edit_sequence, ref_number, ...) -- lets a log line name the order without a
// second query when this same response already carried it.
const REF_NUMBER_COL = 2;

/**
 * The order number ("TBWC 5769") for a txn_id, for log lines a human reads.
 * Prefers rows already parsed out of this response; falls back to one lookup,
 * then to the raw TxnID if the order isn't synced locally yet.
 */
async function orderLabel(env: Env, txnId: string, parsed: Map<string, any[]>): Promise<string> {
  const fromResponse = parsed.get(txnId)?.[REF_NUMBER_COL];
  if (fromResponse) return String(fromResponse);
  const r = await execQuery(
    env,
    `SELECT ref_number FROM public.qb_sales_order WHERE txn_id = $1`,
    [txnId],
    'qbwc.so.refNumberForPush'
  );
  return r.rows[0]?.ref_number || txnId;
}

/**
 * Plain-English version of a failed *ModRq, for the sync log and the push
 * queue's error column. QB's own statusMessage is jargon ("The provided edit
 * sequence ... is out-of-date") and arrives XML-escaped.
 *
 * 3200 is the expected, self-healing case: the whole session's qbXML is built
 * up front (buildWorkQueue), so a Mod carries the EditSequence the *previous*
 * session's pull stored. Anything touching the order in QB in between --
 * including QB re-stamping it after our own last push -- makes that sequence
 * stale. This session's pull refreshes it and the queued edit goes out next
 * session, so it is only a real problem once it survives a retry.
 */
function pushFailure(
  statusCode: string,
  statusMessage: string | undefined,
  fieldLabel: string,
  label: string,
  retried: boolean
): { detail: string; error: string | null } {
  const qb = statusMessage ? unescapeXml(statusMessage) : '';
  if (statusCode === '3200' && !retried) {
    return {
      detail: `Order ${label} changed in QuickBooks -- ${fieldLabel} will be sent on the next sync`,
      error: null, // expected and self-healing; don't mark the run failed
    };
  }
  if (statusCode === '3200') {
    return {
      detail: `Could not send ${fieldLabel} to order ${label}`,
      error: `Order ${label} keeps changing in QuickBooks between syncs, so the ${fieldLabel} edit never applied (QuickBooks code 3200: ${qb})`,
    };
  }
  return {
    detail: `Could not send ${fieldLabel} to order ${label}`,
    error: `Order ${label}: QuickBooks rejected the ${fieldLabel} edit -- ${qb || 'no message'} (QuickBooks code ${statusCode})`,
  };
}

/** Group queued edits by txn_id, fetch each's current EditSequence, and build one SalesOrderModRq per record. */
async function pendingModRqs(env: Env): Promise<string[]> {
  const pending = await pendingPushes(env, 'SalesOrder');
  const byTxn = new Map<string, PendingPush[]>();
  for (const p of pending) {
    if (!FIELD_TO_QB_TAG[p.field_name]) continue; // unrecognized field — shouldn't happen, skip defensively
    const arr = byTxn.get(p.txn_id) ?? [];
    arr.push(p);
    byTxn.set(p.txn_id, arr);
  }
  if (byTxn.size === 0) return [];

  const r = await execQuery(
    env,
    `SELECT txn_id, edit_sequence FROM public.qb_sales_order WHERE txn_id = ANY($1::text[])`,
    [[...byTxn.keys()]],
    'qbwc.so.editSequenceForPush'
  );
  const editSeqByTxn = new Map<string, string>(r.rows.map((row: any) => [row.txn_id, row.edit_sequence]));

  const rqs: string[] = [];
  for (const [txnId, fields] of byTxn) {
    const editSeq = editSeqByTxn.get(txnId);
    if (!editSeq) continue; // order not synced locally yet — retry once a pull has it
    const tags = fields
      .map((f) => {
        const qbTag = FIELD_TO_QB_TAG[f.field_name];
        return `        <${qbTag}>${escapeXml(f.new_value ?? '')}</${qbTag}>`;
      })
      .join('\n');
    rqs.push(
      `    <SalesOrderModRq requestID="${REQUEST_ID}:mod:${txnId}">\n` +
      `      <SalesOrderMod>\n` +
      `        <TxnID>${escapeXml(txnId)}</TxnID>\n` +
      `        <EditSequence>${escapeXml(editSeq)}</EditSequence>\n` +
      `${tags}\n` +
      `      </SalesOrderMod>\n` +
      `    </SalesOrderModRq>`
    );
  }
  return rqs;
}

async function buildRequest(env: Env): Promise<string> {
  const filter = txnModifiedFilter(await pullSince(env, 'SalesOrder', 'qb_sales_order', 'qbwc.so.since'));
  // qbXML schema order for SalesOrderQueryRq: MaxReturned before
  // ModifiedDateRangeFilter, IncludeLineItems last — QB rejects the whole
  // request (0x80040400) if out of order.
  // No OwnerID element. Two failed attempts at one: "-1" is not a valid
  // GUID (OwnerID is GUIDTYPE) and QB answered "error converting GUID value
  // \"-1\" in field \"OwnerID\""; then 2026-10-28's experiment with our own
  // registered OwnerID (tbwc.qwc, hunting invoice #10522's "Job Name")
  // failed the whole query with 3121 "Data Extension Definitions specified
  // by OwnerID {BE0BBCB0-...} not found for this object type" -- no sales
  // order synced for a day. QB treats an OwnerID with no DataExt definition
  // on the object as a request error. Public (OwnerID 0) custom fields come
  // back as DataExtRet without being asked for.
  const query =
    `    <SalesOrderQueryRq requestID="${REQUEST_ID}" iterator="Start">\n` +
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>${filter}\n` +
    `      <IncludeLineItems>true</IncludeLineItems>\n` +
    `    </SalesOrderQueryRq>`;
  const mods = await pendingModRqs(env);
  return qbxmlDoc([query, ...mods].join('\n'));
}

/** Build the qb_sales_order upsert row from one SalesOrderRet (Query or Mod). */
function rowFromRet(ret: string): { txnId: string; row: any[] } | undefined {
  const txnId = tag(ret, 'TxnID');
  if (!txnId) return undefined;
  const cust = refField(ret, 'CustomerRef');
  const rep = refField(ret, 'SalesRepRef');
  const terms = refField(ret, 'TermsRef');
  const shipMethod = refField(ret, 'ShipMethodRef');
  const customerMsg = refField(ret, 'CustomerMsgRef');
  const customerTaxCode = refField(ret, 'CustomerSalesTaxCodeRef');
  const boolOf = (v: string | undefined) => (v == null ? null : v === 'true');
  return {
    txnId,
    row: [
      txnId,
      tag(ret, 'EditSequence') ?? null,
      tag(ret, 'RefNumber') ?? null,
      cust.listId ?? null,
      cust.fullName ?? null,
      qbDate(tag(ret, 'TxnDate')),
      num(tag(ret, 'TotalAmount')),
      boolOf(tag(ret, 'IsFullyInvoiced')),
      boolOf(tag(ret, 'IsManuallyClosed')),
      JSON.stringify(lineItems(ret, 'SalesOrderLineRet')),
      qbTimeToTs(tag(ret, 'TimeModified')),
      JSON.stringify({ txnId, ret: ret.slice(0, 8000) }),
      tag(ret, 'PONumber') ?? null,
      qbDate(tag(ret, 'DueDate')),
      qbDate(tag(ret, 'ShipDate')),
      tag(ret, 'Memo') ?? null,
      rep.listId ?? null,
      rep.fullName ?? null,
      addrBlockText(ret, 'BillAddressBlock'),
      addrBlockText(ret, 'ShipAddressBlock'),
      terms.fullName ?? null,
      shipMethod.fullName ?? null,
      customerMsg.fullName ?? null,
      customerTaxCode.fullName ?? null,
      JSON.stringify(dataExtBlocks(ret)),
    ],
  };
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'SalesOrderQueryRs');
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] SalesOrderQueryRs status', status, '(QB Pro does not support SalesOrders)');
    return;
  }

  // Collect rows, deduped by txn_id (last wins) — a duplicate key inside one
  // multi-row upsert makes Postgres error with "cannot affect row a second time".
  const byId = new Map<string, any[]>();

  // Scoped to the Query's own *Rs element so a SalesOrderModRs's single Ret
  // (handled separately below) isn't double-counted here.
  const queryBlock = xml.match(/<SalesOrderQueryRs\b[^>]*>([\s\S]*?)<\/SalesOrderQueryRs>/);
  const queryRets = queryBlock ? blocks(queryBlock[1], 'SalesOrderRet') : [];
  console.log(`[QBWC] SalesOrderQueryRs: ${queryRets.length} sales order(s)`);
  for (const ret of queryRets) {
    const parsed = rowFromRet(ret);
    if (parsed) byId.set(parsed.txnId, parsed.row);
  }

  // --- push (SalesOrderModRs) results, requestID "salesorder:mod:<txnId>"
  //     (see pendingModRqs above). A successful Mod returns the full updated
  //     SalesOrderRet, same shape as Query's — folded into the same upsert;
  //     the pushed fields are cleared from qbwc_push_queue once it lands.
  const pending = await pendingPushes(env, 'SalesOrder');
  const queuedByTxn = new Map<string, PendingPush[]>();
  for (const p of pending) {
    const arr = queuedByTxn.get(p.txn_id) ?? [];
    arr.push(p);
    queuedByTxn.set(p.txn_id, arr);
  }

  const modRe = /<SalesOrderModRs\b([^>]*)>([\s\S]*?)<\/SalesOrderModRs>/g;
  let modMatch: RegExpExecArray | null;
  while ((modMatch = modRe.exec(xml)) !== null) {
    const attrs = modMatch[1];
    const inner = modMatch[2];
    const rid = attrs.match(/\brequestID="([^"]*)"/)?.[1];
    const txnId = rid?.startsWith(`${REQUEST_ID}:mod:`) ? rid.slice(`${REQUEST_ID}:mod:`.length) : undefined;
    if (!txnId) continue;
    const queued = queuedByTxn.get(txnId) ?? [];
    const fieldNames = queued.map((q) => q.field_name);
    const fieldLabel = fieldNames.join(', ') || 'field';
    const sc = attrs.match(/\bstatusCode="([^"]*)"/)?.[1];
    if (sc && sc !== '0') {
      const msg = attrs.match(/\bstatusMessage="([^"]*)"/)?.[1];
      const label = await orderLabel(env, txnId, byId);
      // Already 'failed' = an earlier session tried this same edit and lost too.
      const retried = queued.some((q) => q.status === 'failed');
      const { detail, error } = pushFailure(sc, msg, fieldLabel, label, retried);
      console.error(`[QBWC] SalesOrderMod (push) failed for order ${label} (${txnId}): ${sc} ${msg}`);
      if (fieldNames.length) await markFailed(env, 'SalesOrder', txnId, fieldNames, error ?? detail);
      await logDetail(env, 'SalesOrder', 'push', detail, error);
      continue; // retried next session with the current edit_sequence
    }
    const ret = blocks(inner, 'SalesOrderRet')[0];
    const parsed = ret ? rowFromRet(ret) : undefined;
    if (parsed) byId.set(parsed.txnId, parsed.row);
    if (fieldNames.length) await markPushed(env, 'SalesOrder', txnId, fieldNames);
    const refLabel = ret ? (tag(ret, 'RefNumber') ?? txnId) : txnId;
    await logDetail(env, 'SalesOrder', 'push', `Pushed ${fieldLabel} to order ${refLabel}`);
  }

  // Batched multi-row upserts: execQuery opens a connection per call, so an
  // iterator page must be a handful of statements, not one per record.
  const CASTS = [
    '', '', '', '', '', '', '', '', '', '::jsonb', '', '::jsonb', '', '', '', '', '', '',
    '', '', '', '', '', '', '::jsonb',
  ];
  for (const rows of chunk([...byId.values()], BATCH_SIZE)) {
    await execQuery(
      env,
      `INSERT INTO public.qb_sales_order
         (txn_id, edit_sequence, ref_number, customer_list_id, customer_name, txn_date,
          total, is_fully_invoiced, is_manually_closed, lines, time_modified, raw,
          po_number, due_date, shipped_date, memo, sales_rep_list_id, sales_rep,
          bill_address_block, ship_address_block, freight_terms, ship_via, contact,
          customer_tax_code, data_ext, synced_at)
       VALUES ${multiRowValues(rows.length, CASTS, ', CURRENT_TIMESTAMP')}
       ON CONFLICT (txn_id) DO UPDATE SET
         edit_sequence=EXCLUDED.edit_sequence, ref_number=EXCLUDED.ref_number,
         customer_list_id=EXCLUDED.customer_list_id, customer_name=EXCLUDED.customer_name,
         txn_date=EXCLUDED.txn_date, total=EXCLUDED.total, is_fully_invoiced=EXCLUDED.is_fully_invoiced,
         is_manually_closed=EXCLUDED.is_manually_closed, lines=EXCLUDED.lines,
         time_modified=EXCLUDED.time_modified, raw=EXCLUDED.raw,
         po_number=EXCLUDED.po_number, due_date=EXCLUDED.due_date, shipped_date=EXCLUDED.shipped_date,
         memo=EXCLUDED.memo, sales_rep_list_id=EXCLUDED.sales_rep_list_id, sales_rep=EXCLUDED.sales_rep,
         bill_address_block=EXCLUDED.bill_address_block, ship_address_block=EXCLUDED.ship_address_block,
         freight_terms=EXCLUDED.freight_terms, ship_via=EXCLUDED.ship_via, contact=EXCLUDED.contact,
         customer_tax_code=EXCLUDED.customer_tax_code, data_ext=EXCLUDED.data_ext,
         synced_at=CURRENT_TIMESTAMP`,
      rows.flat(),
      'qbwc.so.upsert'
    );
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (qb_list_id, qb_edit_sequence, object_type, last_synced_at)
       VALUES ${multiRowValues(rows.length, ['', ''], `, 'SalesOrder', CURRENT_TIMESTAMP`)}
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence=EXCLUDED.qb_edit_sequence, last_synced_at=CURRENT_TIMESTAMP`,
      rows.flatMap((r) => [r[0], r[1]]),
      'qbwc.so.map'
    );
  }

  if (byId.size > 0) await refreshOrderInvoiceStatus(env);
}

const salesOrder: QbObject = {
  name: 'SalesOrder',
  requestID: REQUEST_ID,
  buildRequest,
  parseResponse,
  iteratorExtra: '      <IncludeLineItems>true</IncludeLineItems>\n',
  incremental: true,
};
export default salesOrder;
