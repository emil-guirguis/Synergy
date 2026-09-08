-- "Commission" (COMM 15%, spreadsheet col P) becomes its own real, editable
-- column; commission_total (col S) becomes a Postgres GENERATED column so it
-- can never drift from commission + overage — the DB itself rejects any
-- direct write to it, not just a UI convention. Matches the price workbook
-- calculator's "TOTAL DUE (COMM+OVG)" formula: commission + overage only —
-- project_admin_fee and trade_ally_fee are separate, independent figures, not
-- part of this total.
--
-- No existing qb_sales_order row has commission_total, overage,
-- project_admin_fee, or trade_ally_fee set yet, so this is a plain column swap
-- with nothing to preserve.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS commission numeric(15,2);

ALTER TABLE public.qb_sales_order
  DROP COLUMN IF EXISTS commission_total;

ALTER TABLE public.qb_sales_order
  ADD COLUMN commission_total numeric(15,2)
    GENERATED ALWAYS AS (
      CASE WHEN commission IS NULL AND overage IS NULL THEN NULL
           ELSE COALESCE(commission, 0) + COALESCE(overage, 0)
      END
    ) STORED;
