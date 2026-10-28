-- TBWC migration 121 — two gaps found auditing invoice #10522's printout
-- against a real QB-generated PDF (2026-10-28):
--
-- 1. freight_acct_zip: migration 120 added every "TBWC Invoice" template
--    header field except this one. QB's own element for it is the generic
--    header-level <Other> text box (confirmed: invoice 10522's raw XML has
--    <Other>12345 / acct</Other>, matching its printed Freight Acct/Zip box
--    exactly) — invoice.ts never read it, so documentPdf.ts's freightAcctZip
--    box has always rendered blank regardless of what QB had.
--
-- 2. data_ext: invoice 10522's printout also has a populated "Job Name" box
--    ("Test Job Name") that doesn't come from CustomerRef, Memo, Other, or
--    any element invoice.ts reads — almost certainly a QB custom field
--    (DataExtRet), which invoice.ts has never captured at all (unlike
--    salesOrder.ts/customer.ts, which already store one in `data_ext`).
--    Capturing it is step 1 of finding out what QB is actually calling it
--    and whether our sync can see it (OwnerID visibility is the known
--    unresolved question — see salesOrder.ts's buildRequest comment).
--
-- Both only populate going forward (or on an invoice QB next touches) — same
-- one-time-reload caveat as migration 120.
--
-- Additive and idempotent. Apply once.

ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS freight_acct_zip text,
  ADD COLUMN IF NOT EXISTS data_ext jsonb;

COMMENT ON COLUMN public.qb_invoice.freight_acct_zip IS 'QB''s generic header <Other> text field — TBWC''s invoice template prints it as Freight Acct/Zip. Synced; read-only.';
COMMENT ON COLUMN public.qb_invoice.data_ext         IS 'Every DataExtRet (QB custom field) block QB returned for this invoice, as [{name,value,ownerId}] — same shape as qb_sales_order.data_ext/qb_customer.data_ext. Synced; read-only.';
