-- Engineer name + PO date on a quote — both come off the "2026 Quote List"
-- spreadsheet import (scripts/import-quotes.cjs): the engineer of record for
-- the project, and the date a PO was received against the quote. Manually
-- entered, same TBWC-owned pattern as job_name (migration 076) — no QB source.
ALTER TABLE public.quote
  ADD COLUMN IF NOT EXISTS engineer_name text,
  ADD COLUMN IF NOT EXISTS po_date date;
