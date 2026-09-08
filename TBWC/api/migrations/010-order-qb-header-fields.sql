-- Promote unused QB SalesOrderRet header fields into real columns on
-- qb_sales_order, so they're queryable/sortable/filterable instead of buried
-- in the raw jsonb blob. Confirmed against a live untruncated raw SalesOrderRet
-- (2026-09-06): no DataExtRet (QB custom fields) exist on this object, so these
-- are genuinely new columns, not custom-field promotions.
--
-- shipped_date is repurposed here: it was added in migration 009 as a
-- TBWC-owned manual field but never populated (0 rows set) — it now becomes a
-- QB-synced column fed by SalesOrderRet's own <ShipDate>, so the order list
-- shows QB's actual ship date instead of requiring manual entry.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS po_number         text,
  ADD COLUMN IF NOT EXISTS due_date          date,
  ADD COLUMN IF NOT EXISTS memo              text,
  ADD COLUMN IF NOT EXISTS sales_rep_list_id text,  -- SalesRepRef ListID -> qb_sales_rep.list_id
  ADD COLUMN IF NOT EXISTS sales_rep         text;  -- denormalised SalesRepRef.FullName (the rep Initial, e.g. "POL")

CREATE INDEX IF NOT EXISTS qb_sales_order_sales_rep_list_id_idx
  ON public.qb_sales_order (sales_rep_list_id);
