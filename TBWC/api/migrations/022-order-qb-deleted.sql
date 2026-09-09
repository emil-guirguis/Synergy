-- Track SalesOrders deleted on the QB Desktop side. QB's normal SalesOrderQueryRq
-- never returns a deleted txn (only TxnDeletedQueryRq does), so without this the
-- row just stayed in qb_sales_order forever after a QB-side delete. Soft-delete
-- (not a real DELETE) so TBWC-owned columns (build_notes, commission, etc.) and
-- history survive; API layer hides rows where this is set.
ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS qb_deleted_at timestamptz;
