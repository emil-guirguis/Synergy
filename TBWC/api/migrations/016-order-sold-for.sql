-- "Sold For" — the price the order was actually sold at, as tracked in the
-- rep's build-list spreadsheet. Distinct from both `total` (QB's own order
-- total) and `d_net_cost` (TBWC's D-Net cost basis): these three can all
-- differ on the same order (e.g. a rep-negotiated price above D-Net cost but
-- below/above QB's total), and the workbook's commission calculator computes
-- commission off Sold For, not off total or D-Net cost. TBWC-owned, so it
-- survives every re-sync like the other Financials fields from migration 008.

ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS sold_for numeric(15,2);
