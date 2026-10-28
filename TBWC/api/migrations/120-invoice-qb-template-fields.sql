-- TBWC migration 120 — the QuickBooks InvoiceRet header fields the "TBWC
-- Invoice" template actually prints (confirmed against a real QB-generated
-- invoice PDF, #10459) that the sync never asked for: Terms, Ship Via, FOB,
-- Ship Date, Bill/Ship AddressBlock (QB's own pre-joined text, the same
-- shape qb_sales_order.bill_address_block/ship_address_block already use —
-- see migration 014), and the Sales Tax total/percentage (previously folded
-- into `total` during sync and discarded — see worker/qbwc/objects/invoice.ts).
--
-- Unlike qb_sales_order's TermsRef (migration 014's comment: this company's
-- Terms list holds freight-handling codes on sales orders), the sample
-- invoice's own Terms box reads "Net 30" — a real payment term. Invoices and
-- sales orders apparently get different TermsRef values picked at
-- transaction time off the same master list, so `terms` here is not the
-- same misnomer qb_sales_order.freight_terms is.
--
-- All seven are read-only, QB-synced data (like every other qb_invoice
-- column except the AR tab's migration 118/119 additions) — the next QBWC
-- pull overwrites them, same as everything else here.
--
-- These only populate going forward (or on an invoice QB next touches) --
-- the ~7.8k already-synced invoices need a one-time full reload to backfill
-- them, same mechanism migration 008's IncludeLinkedTxns backfill needed:
-- Settings > QB Sync > Reload next to Invoice (routes/qbSync.ts's
-- POST /reload), then run the QuickBooks Web Connector once.
--
-- Additive and idempotent. Apply once.

ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS terms               text,
  ADD COLUMN IF NOT EXISTS ship_via            text,
  ADD COLUMN IF NOT EXISTS fob                 text,
  ADD COLUMN IF NOT EXISTS ship_date           date,
  ADD COLUMN IF NOT EXISTS bill_address_block  text,
  ADD COLUMN IF NOT EXISTS ship_address_block  text,
  ADD COLUMN IF NOT EXISTS sales_tax_total     numeric(15,2),
  ADD COLUMN IF NOT EXISTS sales_tax_percent   numeric(6,3);

COMMENT ON COLUMN public.qb_invoice.terms              IS 'QB TermsRef.FullName — real payment terms on an invoice (e.g. "Net 30"), unlike qb_sales_order.freight_terms. Synced; read-only.';
COMMENT ON COLUMN public.qb_invoice.ship_via            IS 'QB ShipMethodRef.FullName. Synced; read-only.';
COMMENT ON COLUMN public.qb_invoice.fob                 IS 'QB FOB free-text field. Synced; read-only.';
COMMENT ON COLUMN public.qb_invoice.ship_date            IS 'QB ShipDate. Synced; read-only.';
COMMENT ON COLUMN public.qb_invoice.bill_address_block  IS 'QB BillAddressBlock — QB''s own pre-joined Addr1-5 text, same shape as qb_sales_order.bill_address_block. Preferred over reconstructing from qb_customer.bill_addr when present.';
COMMENT ON COLUMN public.qb_invoice.ship_address_block  IS 'QB ShipAddressBlock. No prior equivalent existed on qb_invoice or qb_customer — the invoice PDF had no Ship To box before this.';
COMMENT ON COLUMN public.qb_invoice.sales_tax_total     IS 'QB SalesTaxTotal — previously read only to compute `total` (subtotal + tax) during sync and then discarded. Stored now so the PDF can show its own Sales Tax line.';
COMMENT ON COLUMN public.qb_invoice.sales_tax_percent   IS 'QB SalesTaxPercentage.';
