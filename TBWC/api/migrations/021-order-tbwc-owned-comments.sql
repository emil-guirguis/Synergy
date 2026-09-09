-- Documents which qb_sales_order columns are TBWC-owned (manually entered in
-- the app, survive every QBWC re-sync) vs QB-synced, for anyone reading the
-- table directly (psql, a DB client) without app context. No schema change —
-- comment-only. Source of truth for the split is orderSchema.ts's readOnly
-- flag (readOnly = QB-synced, editable = TBWC-owned); this mirrors that.

COMMENT ON TABLE public.qb_sales_order IS
  'QuickBooks Desktop SalesOrder staging table (synced via QBWC), extended with TBWC-owned columns the sync never touches. See COMMENT ON COLUMN for the split; orderSchema.ts readOnly flag is the authoritative source.';

COMMENT ON COLUMN public.qb_sales_order.job_name IS
  'TBWC-owned. Manually entered; no QB source field (checked, see migrations 014/020).';
COMMENT ON COLUMN public.qb_sales_order.ship_no_later_than IS
  'TBWC-owned. Manually entered deadline.';
COMMENT ON COLUMN public.qb_sales_order.expedite IS
  'TBWC-owned. Manually entered flag.';
COMMENT ON COLUMN public.qb_sales_order.jay IS
  'TBWC-owned. Manually entered flag.';
COMMENT ON COLUMN public.qb_sales_order.sold_for IS
  'TBWC-owned. Price the order was actually sold at, from the rep''s build-list spreadsheet; distinct from QB''s own `total`.';
COMMENT ON COLUMN public.qb_sales_order.d_net_cost IS
  'TBWC-owned. Manually entered cost basis.';
COMMENT ON COLUMN public.qb_sales_order.overage IS
  'TBWC-owned. Manually entered.';
COMMENT ON COLUMN public.qb_sales_order.commission IS
  'TBWC-owned. Manually entered.';
COMMENT ON COLUMN public.qb_sales_order.commission_total IS
  'TBWC-owned, computed. Postgres GENERATED column (commission + overage); not written directly.';
COMMENT ON COLUMN public.qb_sales_order.project_admin_fee IS
  'TBWC-owned. Manually entered.';
COMMENT ON COLUMN public.qb_sales_order.trade_ally_fee IS
  'TBWC-owned. Manually entered.';
COMMENT ON COLUMN public.qb_sales_order.build_notes IS
  'TBWC-owned. Manually entered, shown on the order list.';
COMMENT ON COLUMN public.qb_sales_order.notes IS
  '"Order Notes" in the UI. TBWC-owned, manually entered; distinct from build_notes and from QB''s own `memo` column.';
