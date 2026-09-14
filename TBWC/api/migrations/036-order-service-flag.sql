-- TBWC-owned "Service" flag on orders: marks an order as service work rather
-- than a product build. Admin-only in the UI (orderSchema.ts gives it
-- visibleFor: ['admin'] and the rep list's REP_FIELD_ORDER leaves it out), and
-- filterable -- a boolean field with showOn 'list' gets a Yes/No filter for
-- free from the schema filter generator.
-- NOT NULL DEFAULT false, matching expedite/jay (migration 008): the flag is
-- either set or not, never unknown.
ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS service boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.qb_sales_order.service IS
  'TBWC-owned: order is service work, not a product build. Survives QB re-sync.';
