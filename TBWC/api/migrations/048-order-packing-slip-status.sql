-- Fixes invoice_number/invoice_status picking up zero-total invoices (this
-- company records packing slips in QB as zero-total invoices — see
-- OrderInvoicesPanel.tsx) as if they were the order's real invoice, and adds
-- has_packing_slip so that fact isn't lost, just no longer misfiled onto the
-- invoice column. Mirrors the corrected query in orderInvoiceStatus.ts.
-- Follows naming convention: {tablename}_id primary keys.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS has_packing_slip boolean NOT NULL DEFAULT false;

UPDATE public.qb_sales_order so
SET invoice_number = calc.invoice_number,
    invoice_status = calc.invoice_status,
    has_packing_slip = calc.has_packing_slip
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
         COALESCE(pack.has_packing_slip, false) AS has_packing_slip
  FROM public.qb_sales_order so2
  LEFT JOIN LATERAL (
    SELECT i.ref_number, i.is_paid
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
       OR so.has_packing_slip IS DISTINCT FROM calc.has_packing_slip);
