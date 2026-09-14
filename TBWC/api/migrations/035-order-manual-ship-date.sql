-- A manually entered ship date, TBWC-owned and never touched by the QB sync.
--
-- Distinct from shipped_date: that column was itself a manual field in
-- migration 009, then repurposed by migration 010 into a QB-synced column fed
-- by SalesOrderRet's own <ShipDate>. QB's value is the scheduled/ship-by date
-- QB carries on the order, so there was no longer anywhere to record the date
-- the order actually shipped. This column is that field, back as its own
-- column so the sync can never overwrite it (salesOrder.ts's upsert lists its
-- columns explicitly, so a new column is left alone).
--
-- Visible to reps as well as admins (orderSchema.ts has no visibleFor on it),
-- but only an admin can write it -- PUT /api/orders/:id is requireAdmin.
ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS actual_ship_date date;
