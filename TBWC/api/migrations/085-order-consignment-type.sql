-- Adds 'consignment' as a second TBWC-only placeholder order_type, alongside
-- 'hold_for_release' (migration 069) -- same deal: created from the Orders
-- list's New menu, fully editable (routes/orders.ts's HOLD_WRITABLE, now
-- shared by both placeholder types), never pushed to QuickBooks. Set once at
-- creation and immutable after.
ALTER TABLE public.qb_sales_order
  DROP CONSTRAINT IF EXISTS qb_sales_order_order_type_check;
ALTER TABLE public.qb_sales_order
  ADD CONSTRAINT qb_sales_order_order_type_check
  CHECK (order_type IN ('order', 'hold_for_release', 'consignment'));

COMMENT ON COLUMN public.qb_sales_order.order_type IS
  'order = normal QB-synced order (default); hold_for_release/consignment = TBWC-only placeholders, never pushed to QuickBooks. Set once at creation, immutable after.';
