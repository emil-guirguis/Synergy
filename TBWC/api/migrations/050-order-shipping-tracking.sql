-- Adds order.shipping_tracking, denormalised from the linked invoice's
-- FREIGHT line item's Desc -- same source/pick as order.freight (migration
-- 049). This is free-typed shipping notes (carrier, date, sometimes a
-- tracking number), not a structured QB field, so it's carried verbatim
-- rather than regex-parsed into just a number -- most invoices mix carrier
-- name/date/notes into the same string and a small number never had a
-- number pasted in at all. A handful of invoices carry more than one FREIGHT
-- line; those Descs are joined with '; ', in line-item order.
-- Follows naming convention: {tablename}_id primary keys.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS shipping_tracking text;

UPDATE public.qb_sales_order so
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
           (SELECT string_agg(line->>'desc', '; ' ORDER BY ord)
              FROM jsonb_array_elements(i.lines) WITH ORDINALITY AS t(line, ord)
             WHERE line->>'item' ILIKE 'FREIGHT' AND line->>'desc' IS NOT NULL) AS shipping_tracking
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
       OR so.shipping_tracking IS DISTINCT FROM calc.shipping_tracking);
