-- TBWC migration 030 — required vs optional kit lines.
--
-- A kit's contents are not all mandatory: the core parts must ship for the kit
-- to be a kit, while accessories are offered with it and can be dropped. One
-- flag per line, so a quote or pick list can leave the optional ones out.
--
-- DEFAULT true because that is what a kit line means unless someone says
-- otherwise — every row that exists today was entered as part of the kit.
ALTER TABLE public.kit_items
  ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true;
