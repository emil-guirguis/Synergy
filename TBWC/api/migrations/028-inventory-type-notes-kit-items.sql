-- TBWC migration 028 — kits.
--
-- Two more TBWC-owned columns on the QB-synced item list, plus the child table
-- that turns an item into a kit.
--
-- Same TBWC-owned-columns rule as 012/027: the QBWC item upsert
-- (worker/qbwc/objects/item.ts) names its columns explicitly and never SETs
-- these, so they survive every QuickBooks re-sync. QuickBooks has no notion of
-- a TBWC kit — these are ours alone.

-- ---------------------------------------------------------------------------
-- 1) TBWC-owned columns on qb_item
ALTER TABLE public.qb_item
  -- 'kit'  = this row is a bundle; its contents live in kit_items below.
  -- 'item' = an ordinary catalog line. Default, and what every existing row is.
  ADD COLUMN IF NOT EXISTS type  text NOT NULL DEFAULT 'item',
  -- Free-text internal notes. Rep/admin scratchpad — not printed, not synced.
  ADD COLUMN IF NOT EXISTS notes text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qb_item_type_check') THEN
    ALTER TABLE public.qb_item
      ADD CONSTRAINT qb_item_type_check CHECK (type IN ('kit', 'item'));
  END IF;
END $$;

-- Kits are a small minority of a 1000+ row catalog, and the list filters on
-- them ("show me the kits"), so the index earns its keep.
CREATE INDEX IF NOT EXISTS qb_item_type_idx ON public.qb_item (type);

-- ---------------------------------------------------------------------------
-- 2) kit_items — the contents of a kit.
--
-- BOTH foreign keys point at qb_item, and which is which matters:
--   qb_item_id = the KIT (the parent row, type='kit')
--   item_id    = the CHILD line in that kit (any catalog item)
-- so one kit has many kit_items rows.
--
-- group_id is a plain integer, not an FK: it is a grouping number the user
-- types/drags in the grid ("everything in group 1 prints together"). No group
-- table on purpose — there is nothing to store about a group beyond its number.
--
-- order_by is the sort position within a group, rewritten wholesale by the
-- drag-and-drop grid on every reorder (the API replaces a kit's rows as a set,
-- see PUT /api/inventory/:id/kit-items), so gaps and renumbering are expected
-- and no client depends on the values being stable.
CREATE TABLE IF NOT EXISTS public.kit_items (
  kit_items_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  qb_item_id   bigint NOT NULL,
  item_id      bigint NOT NULL,
  group_id     integer,
  order_by     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- CASCADE on both sides, not RESTRICT: the QuickBooks sync deletes qb_item
  -- rows (see 022-order-qb-deleted.sql), and a kit line must never be able to
  -- block a sync. Losing the line with the item it named is the right outcome —
  -- the line is meaningless without it.
  CONSTRAINT kit_items_kit_fkey FOREIGN KEY (qb_item_id)
    REFERENCES public.qb_item (qb_item_id) ON DELETE CASCADE,
  CONSTRAINT kit_items_item_fkey FOREIGN KEY (item_id)
    REFERENCES public.qb_item (qb_item_id) ON DELETE CASCADE,
  -- A kit containing itself is a rendering infinite loop, not a valid bundle.
  CONSTRAINT kit_items_no_self_check CHECK (item_id <> qb_item_id)
) TABLESPACE pg_default;

-- The one query this table has: every line of one kit, in display order.
CREATE INDEX IF NOT EXISTS kit_items_kit_idx
  ON public.kit_items (qb_item_id, group_id, order_by);
-- Reverse lookup: "which kits contain this item?" — needed before deleting or
-- discontinuing an item, and by the child FK's cascade check.
CREATE INDEX IF NOT EXISTS kit_items_item_idx ON public.kit_items (item_id);

-- Same posture as document/company_settings: the Worker connects as postgres
-- (table owner, bypasses RLS). RLS on with no policies means the PostgREST
-- roles get nothing — all access goes through the Worker API, which applies the
-- Inventory module's auth.
ALTER TABLE public.kit_items OWNER TO postgres;
ALTER TABLE public.kit_items ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.kit_items TO postgres;
GRANT ALL ON TABLE public.kit_items TO service_role;
