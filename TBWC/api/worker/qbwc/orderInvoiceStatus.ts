/**
 * Denormalise each sales order's invoice number/status/freight/shipping-note
 * onto qb_sales_order. The order module lists/filters/sorts these through the
 * generic CRUD path, so they live as real columns instead of a per-request
 * lateral join. Runs after every SalesOrder and Invoice sync page (cheap:
 * only rows whose computed value changed are written). Mirrored by the
 * backfill in migration 048 (invoice_number/status/has_packing_slip), 049
 * (freight) and 050 (shipping_tracking).
 *
 * Invoices deleted in QB (qb_deleted_at, see qbwc/objects/txnDeleted.ts) are
 * excluded, so a deleted invoice drops back off the order it was quoted on
 * instead of leaving a stale number behind — txnDeleted.ts re-runs this after
 * marking any invoice deleted. Zero-total invoices are excluded from the
 * invoice_number/invoice_status/freight pick too — this company records
 * packing slips in QB as zero-total invoices (see OrderInvoicesPanel.tsx), so
 * the "latest linked invoice" must skip those or a packing slip issued after
 * the real invoice would silently overwrite the real invoice number/status.
 * Their presence is tracked separately via has_packing_slip instead.
 *
 * Status precedence: Paid > Invoiced > Partially Invoiced > Closed > Not
 * Invoiced. QB's own is_fully_invoiced flag drives 'Invoiced' even when no
 * linked invoice row has synced yet (LinkedTxn linkage only exists on invoices
 * pulled after migration 008), so the number may lag the status briefly.
 *
 * freight: QB's sales order never carries freight itself — this company adds
 * it as a "FREIGHT" line item at invoicing time, so it only ever shows up on
 * the linked invoice's own line items. Summed off that same "latest real
 * invoice" picked above (NULL, not 0, when no such invoice is linked yet — an
 * order with an invoice but no FREIGHT line legitimately sums to 0).
 *
 * shipping_tracking: free-typed shipping notes (carrier, date, a tracking
 * number when someone remembered to paste one). QB stores a line's tracking
 * number as its OWN line item though, not appended to the FREIGHT line's own
 * Desc: a no-Item "continuation" line right after it (e.g. FREIGHT "Shipped
 * via UPS Ground. Tracking #:" followed by a bare "1Z2466XW..." line). So
 * this pulls each FREIGHT line's Desc plus every no-Item line trailing it (up
 * to the next real Item line), not just the FREIGHT line's own Desc — see
 * migration 051. A handful of invoices carry more than one FREIGHT line (e.g.
 * two packages shipped separately) — all Descs are joined with '; ', in
 * line-item order.
 */
import { Env, execQuery } from '../db';

export async function refreshOrderInvoiceStatus(env: Env): Promise<void> {
  await execQuery(
    env,
    `UPDATE public.qb_sales_order so
     SET invoice_number = calc.invoice_number,
         invoice_status = calc.invoice_status,
         has_packing_slip = calc.has_packing_slip,
         freight = calc.freight,
         shipping_tracking = calc.shipping_tracking
     FROM (
       SELECT so2.qb_sales_order_id,
              inv.ref_number AS invoice_number,
              CASE
                WHEN COALESCE(inv.is_paid, false) THEN 'Paid'
                WHEN COALESCE(so2.is_fully_invoiced, false) THEN 'Invoiced'
                WHEN inv.ref_number IS NOT NULL THEN 'Partially Invoiced'
                WHEN COALESCE(so2.is_manually_closed, false) THEN 'Closed'
                ELSE 'Not Invoiced'
              END AS invoice_status,
              COALESCE(pack.has_packing_slip, false) AS has_packing_slip,
              inv.freight AS freight,
              inv.shipping_tracking AS shipping_tracking
       FROM public.qb_sales_order so2
       LEFT JOIN LATERAL (
         SELECT i.ref_number, i.is_paid,
                (SELECT COALESCE(SUM((line->>'amount')::numeric), 0)
                   FROM jsonb_array_elements(i.lines) AS line
                  WHERE line->>'item' ILIKE 'FREIGHT') AS freight,
                -- Group lines into blocks starting at each real-Item line
                -- (block_id bumps on every Item line), so a FREIGHT line's
                -- trailing no-Item tracking-number line(s) land in the same
                -- block as the FREIGHT line itself instead of being dropped.
                (SELECT string_agg(blk.block_desc, '; ' ORDER BY blk.block_id)
                   FROM (
                     SELECT lo.block_id,
                            bool_or(lo.item ILIKE 'FREIGHT') AS is_freight,
                            string_agg(lo.desc, '; ' ORDER BY lo.ord) FILTER (WHERE lo.desc IS NOT NULL) AS block_desc
                       FROM (
                         SELECT t.ord, t.line->>'item' AS item, t.line->>'desc' AS desc,
                                SUM(CASE WHEN t.line->>'item' IS NOT NULL THEN 1 ELSE 0 END)
                                  OVER (ORDER BY t.ord) AS block_id
                           FROM jsonb_array_elements(i.lines) WITH ORDINALITY AS t(line, ord)
                       ) lo
                      GROUP BY lo.block_id
                   ) blk
                  WHERE blk.is_freight) AS shipping_tracking
         FROM public.qb_invoice i
         WHERE i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', so2.txn_id))
           AND i.qb_deleted_at IS NULL
           AND COALESCE(i.total, 0) > 0
         ORDER BY i.txn_date DESC NULLS LAST, i.qb_invoice_id DESC
         LIMIT 1
       ) inv ON true
       LEFT JOIN LATERAL (
         SELECT true AS has_packing_slip
         FROM public.qb_invoice i
         WHERE i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', so2.txn_id))
           AND i.qb_deleted_at IS NULL
           AND COALESCE(i.total, 0) = 0
         LIMIT 1
       ) pack ON true
     ) calc
     WHERE so.qb_sales_order_id = calc.qb_sales_order_id
       AND (so.invoice_number IS DISTINCT FROM calc.invoice_number
            OR so.invoice_status IS DISTINCT FROM calc.invoice_status
            OR so.has_packing_slip IS DISTINCT FROM calc.has_packing_slip
            OR so.freight IS DISTINCT FROM calc.freight
            OR so.shipping_tracking IS DISTINCT FROM calc.shipping_tracking)`,
    [],
    'qbwc.orderInvoiceStatus.refresh'
  );
}
