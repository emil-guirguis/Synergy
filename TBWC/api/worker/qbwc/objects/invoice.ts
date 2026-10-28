/**
 * Invoice pull (QB -> qb_invoice). Incremental via FromModifiedDate. Lines are
 * flattened into a jsonb array; header customer ref + totals into columns.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, refField, lineItems,
  qbTimeToTs, qbDate, num, txnModifiedFilter, QB_MAX_RETURNED, addrBlockText, dataExtBlocks,
} from '../qbxml';
import { refreshOrderInvoiceStatus } from '../orderInvoiceStatus';
import { pullSince } from '../incremental';
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
  // pullSince() decides the window: a queued full reload (dashboard reload
  // button) pulls everything, a pending drain falls back to the last
  // confirmed-safe point rather than this table's own MAX(time_modified), and
  // otherwise it's that MAX(). See incremental.ts / migration 025.
  const since = await pullSince(env, 'Invoice', 'qb_invoice', 'qbwc.invoice.since');
  const filter = txnModifiedFilter(since);
  // Paged via iterator, same as customer/item/salesOrder — without it QB caps
  // an un-iterated InvoiceQueryRq well short of the full result set (seen:
  // 187 back when the whole company file has far more invoices than that).
  // qbXML schema order: MaxReturned before the date filter, then
  // IncludeLineItems and IncludeLinkedTxns last, in that order.
  // IncludeLinkedTxns is what makes QB emit the <LinkedTxn> blocks tying an
  // invoice back to the sales order it was created from. Without it QB omits
  // them silently -- which left linked_txn as [] on all 7.8k synced rows, so
  // the order module's invoice_number/invoice_status (orderInvoiceStatus.ts)
  // and the order form billing panel had nothing to join on.
  return qbxmlDoc(
    `    <InvoiceQueryRq requestID="${REQUEST_ID}" iterator="Start">\n` +
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>${filter}\n` +
    `      <IncludeLineItems>true</IncludeLineItems>\n` +
    `      <IncludeLinkedTxns>true</IncludeLinkedTxns>\n` +
    // EXPERIMENT (2026-10-28, invoice #10522's "Job Name" field): DataExtRet
    // only comes back for OwnerID-0 (public) custom fields unless the owning
    // app's own OwnerID is explicitly requested too (see customer.ts/
    // salesOrder.ts's comment on the GUID-vs-"-1" mistake that broke this
    // before). Trying our own registered OwnerID (tbwc.qwc) on the chance a
    // past version of this integration created the field under it. If this
    // doesn't surface it on the next sync, revert -- it's not the answer.
    `      <OwnerID>0</OwnerID>\n` +
    `      <OwnerID>{BE0BBCB0-85E3-431A-8248-B818B948814A}</OwnerID>\n` +
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
    // QB stamps the rep on the invoice itself — this is what scopes a rep's
    // invoice list (see routes/invoices.ts). Not every invoice carries one.
    const rep = refField(ret, 'SalesRepRef');
    // Migration 066: which invoice template QB used -- the reliable signal
    // for "this is a packing slip, not a real invoice" (see is_packing_slip).
    const tmpl = refField(ret, 'TemplateRef');
    // Migration 120: the rest of what the "TBWC Invoice" QB template prints
    // that nothing here asked for before — same fields salesOrder.ts already
    // reads off SalesOrderRet (TermsRef/ShipMethodRef/AddressBlock), here off
    // InvoiceRet instead. No extra request flags needed: QB returns all of
    // these on a plain InvoiceQueryRq the same way it does for SalesOrderQueryRq.
    const terms = refField(ret, 'TermsRef');
    const shipMethod = refField(ret, 'ShipMethodRef');
    const subtotal = num(tag(ret, 'Subtotal'));
    const salesTaxTotal = num(tag(ret, 'SalesTaxTotal'));
    byId.set(txnId, [
      txnId,
      tag(ret, 'EditSequence') ?? null,
      tag(ret, 'RefNumber') ?? null,
      // Migration 037: the billing panel falls back to (customer + PO) when
      // linked_txn is empty, as it is on every invoice QB returned before
      // IncludeLinkedTxns was added above.
      tag(ret, 'PONumber') ?? null,
      cust.listId ?? null,
      cust.fullName ?? null,
      rep.listId ?? null,
      tmpl.fullName ?? null,
      qbDate(tag(ret, 'TxnDate')),
      qbDate(tag(ret, 'DueDate')),
      subtotal,
      // QB InvoiceRet has no Total element: total = Subtotal + SalesTaxTotal.
      (() => {
        if (subtotal == null && salesTaxTotal == null) return null;
        return (subtotal ?? 0) + (salesTaxTotal ?? 0);
      })(),
      num(tag(ret, 'BalanceRemaining')),
      (() => { const b = num(tag(ret, 'BalanceRemaining')); return b == null ? null : b === 0; })(),
      JSON.stringify(lineItems(ret, 'InvoiceLineRet')),
      JSON.stringify(linkedTxns(ret)),
      qbTimeToTs(tag(ret, 'TimeModified')),
      JSON.stringify({ txnId, ret: ret.slice(0, 8000) }),
      terms.fullName ?? null,
      shipMethod.fullName ?? null,
      tag(ret, 'FOB') ?? null,
      qbDate(tag(ret, 'ShipDate')),
      addrBlockText(ret, 'BillAddressBlock'),
      addrBlockText(ret, 'ShipAddressBlock'),
      salesTaxTotal,
      num(tag(ret, 'SalesTaxPercentage')),
      // Migration 121: QB's generic header text box — TBWC's template prints
      // it as Freight Acct/Zip (confirmed against invoice #10522's own value).
      tag(ret, 'Other') ?? null,
      JSON.stringify(dataExtBlocks(ret)),
    ]);
  }

  // Batched multi-row upserts: execQuery opens a connection per call, so an
  // iterator page must be a handful of statements, not one per record (a
  // per-record loop was slow enough to blow the Web Connector's response
  // timeout mid-page, silently truncating large pulls).
  const CASTS = [
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '::jsonb', '::jsonb', '', '::jsonb',
    '', '', '', '', '', '', '', '', // migration 120's 8 new columns
    '', '::jsonb', // migration 121's 2 new columns
  ];
  for (const rows of chunk([...byId.values()], BATCH_SIZE)) {
    await execQuery(
      env,
      `INSERT INTO public.qb_invoice
         (txn_id, edit_sequence, ref_number, po_number, customer_list_id, customer_name, sales_rep_list_id, template_name,
          txn_date, due_date, subtotal, total, balance_remaining, is_paid, lines, linked_txn, time_modified, raw,
          terms, ship_via, fob, ship_date, bill_address_block, ship_address_block, sales_tax_total, sales_tax_percent,
          freight_acct_zip, data_ext, synced_at)
       VALUES ${multiRowValues(rows.length, CASTS, ', CURRENT_TIMESTAMP')}
       ON CONFLICT (txn_id) DO UPDATE SET
         edit_sequence=EXCLUDED.edit_sequence, ref_number=EXCLUDED.ref_number, po_number=EXCLUDED.po_number,
         customer_list_id=EXCLUDED.customer_list_id, customer_name=EXCLUDED.customer_name,
         sales_rep_list_id=EXCLUDED.sales_rep_list_id, template_name=EXCLUDED.template_name,
         txn_date=EXCLUDED.txn_date, due_date=EXCLUDED.due_date, subtotal=EXCLUDED.subtotal,
         total=EXCLUDED.total, balance_remaining=EXCLUDED.balance_remaining, is_paid=EXCLUDED.is_paid,
         lines=EXCLUDED.lines, linked_txn=EXCLUDED.linked_txn, time_modified=EXCLUDED.time_modified,
         raw=EXCLUDED.raw, synced_at=CURRENT_TIMESTAMP,
         terms=EXCLUDED.terms, ship_via=EXCLUDED.ship_via, fob=EXCLUDED.fob, ship_date=EXCLUDED.ship_date,
         bill_address_block=EXCLUDED.bill_address_block, ship_address_block=EXCLUDED.ship_address_block,
         sales_tax_total=EXCLUDED.sales_tax_total, sales_tax_percent=EXCLUDED.sales_tax_percent,
         freight_acct_zip=EXCLUDED.freight_acct_zip, data_ext=EXCLUDED.data_ext`,
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
  iteratorExtra:
    '      <IncludeLineItems>true</IncludeLineItems>\n' +
    '      <IncludeLinkedTxns>true</IncludeLinkedTxns>\n',
  incremental: true,
};
export default invoice;
