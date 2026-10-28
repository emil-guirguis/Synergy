-- TBWC migration 119 — "late fee applied" flag on invoices (Invoices > a
-- record > AR tab, alongside the collection notices from migration 118).
--
-- TBWC-owned like the rest of that tab: QuickBooks has no such field, the QBWC
-- pull never names this column, and routes/invoices.ts's WRITABLE allowlist is
-- what lets a PUT reach it.
--
-- NOT NULL DEFAULT false rather than a nullable boolean: "we haven't decided"
-- and "no late fee" are the same thing operationally, and a three-state
-- checkbox would just make the list filter ambiguous.
--
-- Additive and idempotent. Apply once.

ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS late_fee_applied boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.qb_invoice.late_fee_applied IS
  'TBWC-owned. Whether a late fee has been applied to this invoice. Never touched by the QBWC sync; QuickBooks has no equivalent field.';
