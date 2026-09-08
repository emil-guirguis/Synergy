-- Inventory module moves onto public.qb_item (the QB-synced staging table),
-- same pattern as the Order module's move onto qb_sales_order (migration 008):
-- adds TBWC-owned columns that the QBWC item upsert never SETs, so they
-- survive every re-sync. public.inventory (the one-time workbook seed) was
-- dropped manually on 2026-09-06 without replacing what read from it.

-- ---------------------------------------------------------------------------
-- 1) TBWC-owned columns on qb_item
ALTER TABLE public.qb_item
  ADD COLUMN IF NOT EXISTS category          text,
  ADD COLUMN IF NOT EXISTS upc_code          text,
  ADD COLUMN IF NOT EXISTS distribution_type text,
  ADD COLUMN IF NOT EXISTS base_price        numeric(15,2),
  ADD COLUMN IF NOT EXISTS msrp              numeric(15,2),
  ADD COLUMN IF NOT EXISTS dnet_cost         numeric(15,2),
  ADD COLUMN IF NOT EXISTS moq               integer,
  ADD COLUMN IF NOT EXISTS pack_qty          integer,
  ADD COLUMN IF NOT EXISTS service_days      integer,
  ADD COLUMN IF NOT EXISTS unit_weight       numeric(12,3);

CREATE INDEX IF NOT EXISTS qb_item_category_idx ON public.qb_item (category);

-- ---------------------------------------------------------------------------
-- 2) quote_line.inventory_id pointed at the dropped public.inventory table
--    (FK already gone with it). Rename to qb_item_id and repoint at qb_item;
--    existing values are stale inventory_id's with no matching qb_item row,
--    so they're cleared rather than left as silently-wrong FKs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'quote_line'
                AND column_name = 'inventory_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'quote_line'
                AND column_name = 'qb_item_id') THEN
    ALTER TABLE public.quote_line RENAME COLUMN inventory_id TO qb_item_id;
  END IF;
END $$;

UPDATE public.quote_line SET qb_item_id = NULL WHERE qb_item_id IS NOT NULL;

ALTER TABLE public.quote_line DROP CONSTRAINT IF EXISTS quote_line_inventory_fkey;
ALTER TABLE public.quote_line
  ADD CONSTRAINT quote_line_qb_item_fkey FOREIGN KEY (qb_item_id)
    REFERENCES public.qb_item (qb_item_id) ON DELETE SET NULL;

DROP INDEX IF EXISTS quote_line_inventory_id_idx;
CREATE INDEX IF NOT EXISTS quote_line_qb_item_id_idx ON public.quote_line (qb_item_id);
