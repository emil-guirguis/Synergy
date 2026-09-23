-- Adds order.freight, denormalised from the linked invoice's FREIGHT line
-- item -- QB never puts freight on the sales order itself; this company adds
-- it as a line item when the order gets invoiced, so it only ever shows up on
-- the invoice. NULL when no real (>0 total) invoice is linked yet; 0.00 when
-- one is linked but carries no FREIGHT line. Same linked-invoice pick and
-- same refresh trigger as invoice_number/invoice_status/has_packing_slip
-- (migration 048, orderInvoiceStatus.ts).
-- Follows naming convention: {tablename}_id primary keys.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS freight numeric(15,2);

UPDATE public.qb_sales_order so
SET invoice_number = calc.invoice_number,
    invoice_status = calc.invoice_status,
    has_packing_slip = calc.has_packing_slip,
    freight = calc.freight
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
         inv.freight AS freight
  FROM public.qb_sales_order so2
  LEFT JOIN LATERAL (
    SELECT i.ref_number, i.is_paid,
           (SELECT COALESCE(SUM((line->>'amount')::numeric), 0)
              FROM jsonb_array_elements(i.lines) AS line
             WHERE line->>'item' ILIKE 'FREIGHT') AS freight
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
       OR so.freight IS DISTINCT FROM calc.freight);

-- Migration 040: "no dollar figure on an order is visible to a rep, anywhere
-- in the payload" -- freight is a new one, so it joins the rest of the list.
UPDATE public.role_permission
   SET hidden_fields = array_append(hidden_fields, 'freight')
 WHERE permission = 'order:read'
   AND scope = 'own'
   AND NOT ('freight' = ANY(hidden_fields));
