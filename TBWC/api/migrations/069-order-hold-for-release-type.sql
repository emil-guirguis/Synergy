-- "Hold for Release" orders: a TBWC-created placeholder for a sale that
-- hasn't been entered in QuickBooks yet, unlike every other row here, which
-- exists only because the QB sync put it there (see orders.ts header
-- comment). Fully editable (routes/orders.ts's HOLD_WRITABLE) and never
-- pushed to QB; an admin deletes the placeholder by hand once the real order
-- is entered in QuickBooks and lands via the normal sync under its own
-- txn_id. Set once at creation and immutable after -- no route ever writes
-- this column again.
-- Follows naming convention: {tablename}_id primary keys.
ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'order';

ALTER TABLE public.qb_sales_order
  DROP CONSTRAINT IF EXISTS qb_sales_order_order_type_check;
ALTER TABLE public.qb_sales_order
  ADD CONSTRAINT qb_sales_order_order_type_check
  CHECK (order_type IN ('order', 'hold_for_release'));

COMMENT ON COLUMN public.qb_sales_order.order_type IS
  'order = normal QB-synced order (default); hold_for_release = TBWC-only placeholder, never pushed to QuickBooks. Set once at creation, immutable after.';
