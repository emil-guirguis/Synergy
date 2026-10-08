-- Fully reverts migration 080: serial numbers turn out to already be sitting
-- in the invoice LINE ITEMS' own Desc text (e.g. "METER SERIAL # P032608004",
-- "Serial #: P122607064" — confirmed against live data), not the invoice
-- header's Memo field (that one just holds things like "Shipped 10-2-26").
-- qb_invoice.lines already carries every line's desc (lineItems(), no sync
-- change needed) so there's nothing to add to qb_invoice at all — GET /:id
-- reads straight off the existing lines column (orders.ts's
-- latestInvoiceSerialNumbers).

ALTER TABLE public.qb_invoice
  DROP COLUMN IF EXISTS memo;
