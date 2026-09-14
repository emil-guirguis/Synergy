-- Track QB-side deletions for every staging table the portal reads, the same way
-- migration 022 did for qb_sales_order. A normal *QueryRq never returns an object
-- a QB Desktop user deleted (only TxnDeletedQueryRq / ListDeletedQueryRq do), so
-- without this a deleted customer/item/invoice/rep stayed in the portal forever.
--
-- Soft-delete, not a real DELETE:
--   * qb_item carries TBWC-owned columns (image_url, notes, type) and is the FK
--     target of kit_items and quote_line — a hard delete would cascade or fail.
--   * qb_sales_rep is the FK target of users.qb_sales_rep_id.
--   * qb_invoice / qb_customer keep history the order module reads through.
-- The API layer hides rows where this is set.
ALTER TABLE public.qb_customer  ADD COLUMN IF NOT EXISTS qb_deleted_at timestamptz;
ALTER TABLE public.qb_item      ADD COLUMN IF NOT EXISTS qb_deleted_at timestamptz;
ALTER TABLE public.qb_invoice   ADD COLUMN IF NOT EXISTS qb_deleted_at timestamptz;
ALTER TABLE public.qb_sales_rep ADD COLUMN IF NOT EXISTS qb_deleted_at timestamptz;
