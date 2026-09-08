-- General free-text "NOTES" (spreadsheet col M) — distinct from build_notes
-- (col B, a separately-tracked field; do not conflate the two, see
-- migration 008's build_notes and this session's mapping notes). TBWC-owned,
-- editable, survives every re-sync like the other TBWC-owned columns.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS notes text;
