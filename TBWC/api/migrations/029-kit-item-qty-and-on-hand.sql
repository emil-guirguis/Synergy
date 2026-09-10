-- TBWC migration 029 — how many of each item a kit contains, and how many are
-- actually in stock.
--
-- Two different quantities, deliberately not the same column:
--   kit_items.qty          — TBWC's own: the kit's recipe ("2 of these per kit").
--   qb_item.quantity_on_hand — QuickBooks': what is physically in stock. Read-only
--                              everywhere in TBWC, overwritten by every sync.

-- ---------------------------------------------------------------------------
-- 1) Recipe quantity on a kit line.
--
-- numeric(12,2) mirrors quote_line.qty rather than integer: the same catalog
-- is sold by the foot and by the roll, and a kit that needs 2.5 ft of cable
-- must be expressible. DEFAULT 1 so existing rows (and any client that omits
-- it) mean "one of these", which is what a kit line without a quantity is.
ALTER TABLE public.kit_items
  ADD COLUMN IF NOT EXISTS qty numeric(12,2) NOT NULL DEFAULT 1;

-- A zero or negative line is not a kit line, it is a mistake.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kit_items_qty_check') THEN
    ALTER TABLE public.kit_items ADD CONSTRAINT kit_items_qty_check CHECK (qty > 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) QuickBooks stock level.
--
-- QB has been sending <QuantityOnHand> in every ItemInventoryRet all along —
-- the Item parser (worker/qbwc/objects/item.ts) simply never read it out, so
-- it only ever survived inside the `raw` blob. This is a QB-OWNED column, the
-- opposite of the TBWC-owned columns in 012/027/028: the item upsert now SETs
-- it on every sync, and nothing in the app writes it.
--
-- NULL is meaningful and is not zero: only Inventory/InventoryAssembly items
-- are stock-tracked at all. A NonInventory or Service line has no on-hand
-- count to show, and rendering "0" for one would read as "out of stock".
ALTER TABLE public.qb_item
  ADD COLUMN IF NOT EXISTS quantity_on_hand numeric(15,4);

-- Backfill from the payloads already stored, so the column is populated before
-- the next QB sync rather than after it. `raw->>'ret'` is the item's qbXML;
-- the value is the digits between the QuantityOnHand tags. Items whose XML has
-- no such tag are left NULL, which is the correct answer for them.
UPDATE public.qb_item
   SET quantity_on_hand = NULLIF(substring(raw->>'ret' from '<QuantityOnHand>([-0-9.]+)</QuantityOnHand>'), '')::numeric
 WHERE quantity_on_hand IS NULL
   AND raw->>'ret' LIKE '%<QuantityOnHand>%';
