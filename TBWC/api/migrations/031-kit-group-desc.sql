-- TBWC migration 031 — a name for each kit group.
--
-- Groups stay what migration 028 made them: a plain integer on the line, no
-- group table. This adds the label that number was missing ("Enclosure",
-- "CTs", "Docs") so the grid's group headers say something.
--
-- Denormalised on purpose — every line of a group carries the same text rather
-- than pointing at a kit_group row. Two reasons: a group has nothing else to
-- store, and the kit-items save already replaces a kit's rows as a set
-- (PUT /api/inventory/:id/kit-items), so rewriting the label on every line of a
-- group is the same one statement per line it already was. The API canonicalises
-- the value per group on save, so the rows of a group cannot drift apart.
--
-- NULL means an unnamed group, which is what every existing row is.
ALTER TABLE public.kit_items
  ADD COLUMN IF NOT EXISTS group_desc text;
