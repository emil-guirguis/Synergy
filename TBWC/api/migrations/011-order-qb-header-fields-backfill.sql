-- One-time backfill of migration 010's new columns from the raw jsonb slice
-- already stored on each existing qb_sales_order row, so the fields show data
-- immediately instead of waiting for every order's next incremental re-sync.
-- Only fills rows whose column is currently NULL; the sync path (salesOrder.ts)
-- is the source of truth going forward. PONumber/DueDate/ShipDate/Memo/SalesRepRef
-- sit in the SalesOrderRet header, before line items, so they survive the raw
-- column's 8000-char truncation on all but pathologically long orders.

UPDATE public.qb_sales_order so
SET po_number = COALESCE(so.po_number, calc.po_number),
    due_date = COALESCE(so.due_date, NULLIF(calc.due_date, '')::date),
    shipped_date = COALESCE(so.shipped_date, NULLIF(calc.ship_date, '')::date),
    memo = COALESCE(so.memo, calc.memo),
    sales_rep_list_id = COALESCE(so.sales_rep_list_id, calc.rep_list_id),
    sales_rep = COALESCE(so.sales_rep, calc.rep_name)
FROM (
  SELECT
    qb_sales_order_id,
    (regexp_match(raw->>'ret', '<PONumber>([^<]*)</PONumber>'))[1] AS po_number,
    (regexp_match(raw->>'ret', '<DueDate>([^<]*)</DueDate>'))[1] AS due_date,
    (regexp_match(raw->>'ret', '<ShipDate>([^<]*)</ShipDate>'))[1] AS ship_date,
    replace(replace(replace(replace(replace(
      (regexp_match(raw->>'ret', '<Memo>([^<]*)</Memo>'))[1],
      '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', '''') AS memo,
    (regexp_match(raw->>'ret', '<SalesRepRef>\s*<ListID>([^<]*)</ListID>'))[1] AS rep_list_id,
    (regexp_match(raw->>'ret', '<SalesRepRef>\s*<ListID>[^<]*</ListID>\s*<FullName>([^<]*)</FullName>'))[1] AS rep_name
  FROM public.qb_sales_order
  WHERE raw->>'ret' IS NOT NULL
) calc
WHERE so.qb_sales_order_id = calc.qb_sales_order_id;
