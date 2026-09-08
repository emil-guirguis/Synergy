/**
 * Denormalise each sales order's invoice number/status onto qb_sales_order.
 * The order module lists/filters/sorts these through the generic CRUD path, so
 * they live as real columns instead of a per-request lateral join. Runs after
 * every SalesOrder and Invoice sync page (cheap: only rows whose computed value
 * changed are written). Mirrored by the backfill in migration 008.
 *
 * Status precedence: Paid > Invoiced > Partially Invoiced > Closed > Not
 * Invoiced. QB's own is_fully_invoiced flag drives 'Invoiced' even when no
 * linked invoice row has synced yet (LinkedTxn linkage only exists on invoices
 * pulled after migration 008), so the number may lag the status briefly.
 */
import { Env, execQuery } from '../db';

export async function refreshOrderInvoiceStatus(env: Env): Promise<void> {
  await execQuery(
    env,
    `UPDATE public.qb_sales_order so
     SET invoice_number = calc.invoice_number,
         invoice_status = calc.invoice_status
     FROM (
       SELECT so2.qb_sales_order_id,
              inv.ref_number AS invoice_number,
              CASE
                WHEN COALESCE(inv.is_paid, false) THEN 'Paid'
                WHEN COALESCE(so2.is_fully_invoiced, false) THEN 'Invoiced'
                WHEN inv.ref_number IS NOT NULL THEN 'Partially Invoiced'
                WHEN COALESCE(so2.is_manually_closed, false) THEN 'Closed'
                ELSE 'Not Invoiced'
              END AS invoice_status
       FROM public.qb_sales_order so2
       LEFT JOIN LATERAL (
         SELECT i.ref_number, i.is_paid
         FROM public.qb_invoice i
         WHERE i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', so2.txn_id))
         ORDER BY i.txn_date DESC NULLS LAST, i.qb_invoice_id DESC
         LIMIT 1
       ) inv ON true
     ) calc
     WHERE so.qb_sales_order_id = calc.qb_sales_order_id
       AND (so.invoice_number IS DISTINCT FROM calc.invoice_number
            OR so.invoice_status IS DISTINCT FROM calc.invoice_status)`,
    [],
    'qbwc.orderInvoiceStatus.refresh'
  );
}
