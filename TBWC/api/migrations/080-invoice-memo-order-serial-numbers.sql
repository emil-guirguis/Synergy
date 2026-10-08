-- Supersedes migration 079: serial numbers turn out to already be written by
-- hand into the QB invoice's own Memo field (common workaround for QB Desktop
-- Pro/Premier, which has no serial/lot tracking) rather than needing a TBWC
-- table of their own. Drop the unused table and read the real source instead:
-- pull Invoice's Memo (invoice.ts) and denormalise it onto the order as
-- serial_numbers, same mechanism orderInvoiceStatus.ts already uses for
-- freight/shipping_tracking off the same "latest linked real invoice".

DROP TABLE IF EXISTS public.order_line_serial;

ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS memo text;

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS serial_numbers text;

-- No backfill UPDATE here: memo is NULL on every already-synced qb_invoice
-- row until QBWC next pulls it (incremental sync only re-pulls a changed
-- invoice) — a full Invoice reload (Settings > QB Sync) populates it for
-- everything at once; otherwise it fills in gradually as invoices are touched.
