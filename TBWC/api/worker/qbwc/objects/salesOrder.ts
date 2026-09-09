/**
 * SalesOrder pull (QB -> qb_sales_order). QB Premier/Enterprise only; on QB Pro
 * the QueryRq returns a statusCode we log and skip. Incremental via FromModifiedDate.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, refField, lineItems,
  qbTimeToTs, qbDate, num, txnModifiedFilter, QB_MAX_RETURNED,
  addrBlockText, dataExtBlocks, escapeXml,
} from '../qbxml';
import { multiRowValues, chunk, BATCH_SIZE } from '../batchSql';
import { refreshOrderInvoiceStatus } from '../orderInvoiceStatus';
import { sinceModified } from '../incremental';
import { pendingPushes, markPushed, markFailed, type PendingPush } from '../pushQueue';
import { logDetail } from '../syncLog';

const REQUEST_ID = 'salesorder';

// TBWC/schema field name (queued via routes/orders.ts's PUSHABLE) -> QB XML tag.
// Add an entry here (and to orders.ts's PUSHABLE) for each new pushable field —
// no migration needed, qbwc_push_queue is generic.
const FIELD_TO_QB_TAG: Record<string, string> = {
  memo: 'Memo',
};

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
  const filter = txnModifiedFilter(await sinceModified(env, 'qb_sales_order', 'qbwc.so.since'));
  // qbXML schema order for SalesOrderQueryRq: MaxReturned before
  // ModifiedDateRangeFilter, IncludeLineItems last — QB rejects the whole
  // request (0x80040400) if out of order.
  // No OwnerID filter here: it's GUIDTYPE, not the INTTYPE sentinel we
  // assumed — "-1" is not a valid GUID and made QB fail the entire request
  // ("error converting GUID value \"-1\" in field \"OwnerID\""), same bug as
  // Customer. Means private (non-public) DataExt custom fields won't come
  // back on sales orders, only OwnerID-0 public ones.
  const query =
    `    <SalesOrderQueryRq requestID="${REQUEST_ID}" iterator="Start">\n` +
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>${filter}\n` +
    `      <IncludeLineItems>true</IncludeLineItems>\n    </SalesOrderQueryRq>`;
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
  const queuedFieldsByTxn = new Map<string, string[]>();
  for (const p of pending) {
    const arr = queuedFieldsByTxn.get(p.txn_id) ?? [];
    arr.push(p.field_name);
    queuedFieldsByTxn.set(p.txn_id, arr);
  }

  const modRe = /<SalesOrderModRs\b([^>]*)>([\s\S]*?)<\/SalesOrderModRs>/g;
  let modMatch: RegExpExecArray | null;
  while ((modMatch = modRe.exec(xml)) !== null) {
    const attrs = modMatch[1];
    const inner = modMatch[2];
    const rid = attrs.match(/\brequestID="([^"]*)"/)?.[1];
    const txnId = rid?.startsWith(`${REQUEST_ID}:mod:`) ? rid.slice(`${REQUEST_ID}:mod:`.length) : undefined;
    if (!txnId) continue;
    const fieldNames = queuedFieldsByTxn.get(txnId) ?? [];
    const fieldLabel = fieldNames.join(', ') || 'field';
    const sc = attrs.match(/\bstatusCode="([^"]*)"/)?.[1];
    if (sc && sc !== '0') {
      const msg = attrs.match(/\bstatusMessage="([^"]*)"/)?.[1];
      console.error(`[QBWC] SalesOrderMod (push) failed for ${txnId}: ${sc} ${msg}`);
      if (fieldNames.length) await markFailed(env, 'SalesOrder', txnId, fieldNames, `${sc} ${msg ?? ''}`.trim());
      await logDetail(env, 'SalesOrder', 'push', `Failed to push ${fieldLabel} for order ${txnId}`, `${sc} ${msg ?? ''}`.trim());
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
};
export default salesOrder;
