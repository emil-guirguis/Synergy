-- Supersedes the serial_numbers half of migration 080: no need to denormalise
-- the linked invoice's Memo onto qb_sales_order at all — routes/orders.ts's
-- GET /:id now reads it live off qb_invoice (same linked-invoice match
-- /:id/invoices already uses) instead of relying on orderInvoiceStatus.ts to
-- have copied it over after a sync. Simpler: one fewer column kept in sync,
-- and no "has this order been re-touched since the memo column was added"
-- staleness question. qb_invoice.memo itself (migration 080) stays — that's
-- the real source data, pulled by invoice.ts's QBXML sync.

ALTER TABLE public.qb_sales_order
  DROP COLUMN IF EXISTS serial_numbers;
