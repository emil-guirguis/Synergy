-- Fixes order.shipping_tracking (migration 052): the freight-less trailing
-- block picked up the block-starting item's OWN Desc along with the real
-- continuation notes -- e.g. invoice 6277's only item is the meter unit
-- itself ("16-Element (48 Circuit) HD Multiple Meter Unit...(DIPS48HD-C-D-N)"),
-- and that whole product description was getting prepended to the actual
-- shipping note ("Meter Serial # P482307182; Shipped via UPS Ground on Acct
-- :9769V8\nTracking # 1Z2466XW0362818872").
--
-- A FREIGHT line's own Desc IS the shipping note (unchanged, still included).
-- A non-FREIGHT trailing block's leading item Desc is just that item's normal
-- description, so only its no-Item continuation lines count now -- see
-- orderInvoiceStatus.ts for the query this mirrors.
-- Follows naming convention: {tablename}_id primary keys.

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
           (WITH lo AS (
              SELECT t.ord, t.line->>'item' AS item, t.line->>'desc' AS desc,
                     SUM(CASE WHEN t.line->>'item' IS NOT NULL THEN 1 ELSE 0 END)
                       OVER (ORDER BY t.ord) AS block_id
                FROM jsonb_array_elements(i.lines) WITH ORDINALITY AS t(line, ord)
            ), blk AS (
              SELECT lo.block_id,
                     bool_or(lo.item ILIKE 'FREIGHT') AS is_freight,
                     count(*) AS row_count,
                     string_agg(lo.desc, '; ' ORDER BY lo.ord) FILTER (WHERE lo.desc IS NOT NULL AND lo.desc <> '') AS full_desc,
                     string_agg(lo.desc, '; ' ORDER BY lo.ord) FILTER (WHERE lo.item IS NULL AND lo.desc IS NOT NULL AND lo.desc <> '') AS continuation_desc
                FROM lo
               GROUP BY lo.block_id
            )
            SELECT string_agg(
                     CASE WHEN blk.is_freight THEN blk.full_desc ELSE blk.continuation_desc END,
                     '; ' ORDER BY blk.block_id)
              FROM blk
             WHERE blk.is_freight
                OR (blk.row_count > 1 AND blk.continuation_desc IS NOT NULL
                    AND blk.block_id = (SELECT max(block_id) FROM blk))
           ) AS shipping_tracking
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
