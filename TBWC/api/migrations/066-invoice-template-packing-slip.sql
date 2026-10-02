-- Replaces the zero-total heuristic for packing slips with QB's own
-- TemplateRef: this company issues packing slips in QB on a dedicated
-- "TBWC Only Packing Slip" invoice template, which is a reliable signal
-- unlike total=0 (some REAL invoices are legitimately zero-total too, e.g.
-- full-discount/credit invoices, and those were being misfiled as packing
-- slips). See orderInvoiceStatus.ts, invoices.ts, invoiceTotals.ts,
-- OrderInvoicesPanel.tsx.
--
-- template_name is pulled fresh via QBWC (invoice.ts, TemplateRef) and is
-- NULL on every invoice synced before this migration until a full resync
-- (dashboard reload button) backfills it. is_packing_slip falls back to the
-- old total=0 heuristic only while template_name is still unknown, so
-- unsynced rows don't regress -- once template_name is populated it's the
-- sole signal.
-- Follows naming convention: {tablename}_id primary keys.

ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS template_name text;

ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS is_packing_slip boolean
  GENERATED ALWAYS AS (
    CASE
      WHEN template_name IS NOT NULL THEN template_name ILIKE 'tbwc only packing slip'
      ELSE COALESCE(total, 0) = 0
    END
  ) STORED;
