-- "Job Name" — manually entered per order (also tracked as column K in the
-- rep's build-list spreadsheet, "TBWC & Dent Build List.xlsx" — see memory
-- tbwc-orders-spreadsheet-mapping for the full column map). No QB source:
-- migration 014 checked for it as a DataExtRet custom field and found nothing
-- on either sample order, so this is a plain TBWC-owned column like
-- build_notes/sold_for — survives every re-sync, entered/edited in the app.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS job_name text;
