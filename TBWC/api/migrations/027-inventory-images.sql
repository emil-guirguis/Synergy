-- TBWC migration 027 — product thumbnails on the inventory catalog.
--
-- Same TBWC-owned-columns pattern as 012: the QBWC item upsert never SETs these,
-- so they survive every QuickBooks re-sync. Populated out-of-band by
-- scripts/fetch-item-images.cjs (web image search + curated family rules), then
-- culled by hand in the Inventory list.
--
-- Why a column and not a `document` row: this is the record's single canonical
-- thumbnail for the printed price sheet, so the print query wants one join-free
-- value. `document` stays what it is — an unbounded per-record attachment list.

-- ---------------------------------------------------------------------------
-- 1) TBWC-owned image columns on qb_item
ALTER TABLE public.qb_item
  -- Public URL of OUR stored thumbnail (item-images bucket). This is what the
  -- printout renders. NULL = no image yet.
  ADD COLUMN IF NOT EXISTS image_url         text,
  -- Where the bytes originally came from. Kept for provenance: if a vendor
  -- objects, or a match looks wrong, this says which page it was scraped from.
  ADD COLUMN IF NOT EXISTS image_source_url  text,
  -- How it was chosen: 'family' (curated rule), 'search' (image search hit),
  -- 'manual' (a human set it).
  ADD COLUMN IF NOT EXISTS image_source      text,
  -- 0-100. Family rules score high; search hits score off how well the result
  -- title echoes the part number. Drives the review sort order — worst first.
  ADD COLUMN IF NOT EXISTS image_confidence  smallint,
  -- Review state. 'pending' = never attempted. 'auto' = machine-picked, not yet
  -- looked at by a human — the printout can be told to skip these. 'approved' /
  -- 'rejected' are human verdicts and the fetch script never overwrites them.
  -- 'none' = deliberately imageless (freight, service, discount lines).
  ADD COLUMN IF NOT EXISTS image_status      text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS image_updated_at  timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qb_item_image_status_check') THEN
    ALTER TABLE public.qb_item
      ADD CONSTRAINT qb_item_image_status_check
      CHECK (image_status IN ('pending', 'auto', 'approved', 'rejected', 'none'));
  END IF;
END $$;

-- The review screen's working query: everything still needing eyes, worst
-- confidence first.
CREATE INDEX IF NOT EXISTS qb_item_image_status_idx
  ON public.qb_item (image_status, image_confidence);

-- ---------------------------------------------------------------------------
-- 2) Line-item types that will never have a product photo. Marking them 'none'
--    up front keeps them out of the review queue and out of the fetch sweep,
--    instead of leaving 86 rows that look permanently unfinished.
UPDATE public.qb_item
   SET image_status = 'none'
 WHERE image_status = 'pending'
   AND item_type IN ('Service', 'OtherCharge', 'Discount');

-- ---------------------------------------------------------------------------
-- 3) Storage bucket for the thumbnails.
--
-- PUBLIC, unlike record-docs. Deliberate, and the reason matters: these images
-- are rendered by a print/PDF pipeline and pasted into rep-facing sheets, and a
-- public object URL is a plain <img src> that works everywhere with no signing
-- round-trip and no token embedded in a printed artifact. The contents are
-- vendor product photos of items TBWC resells — nothing customer- or
-- pricing-derived — so "anyone with the URL can view" costs nothing here.
-- Do NOT put anything else in this bucket.
INSERT INTO storage.buckets (id, name, public)
SELECT 'item-images', 'item-images', true
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'item-images');

-- Reads are public (bucket-level), so no SELECT policy is needed. Writes are
-- service_role only: the fetch script runs server-side with the service key,
-- and the browser never uploads here. No `authenticated` insert/update/delete
-- policy on purpose — a signed-in rep must not be able to swap catalog imagery.
DROP POLICY IF EXISTS "item-images service insert" ON storage.objects;
CREATE POLICY "item-images service insert" ON storage.objects
  FOR INSERT TO service_role WITH CHECK (bucket_id = 'item-images');

DROP POLICY IF EXISTS "item-images service update" ON storage.objects;
CREATE POLICY "item-images service update" ON storage.objects
  FOR UPDATE TO service_role USING (bucket_id = 'item-images') WITH CHECK (bucket_id = 'item-images');

DROP POLICY IF EXISTS "item-images service delete" ON storage.objects;
CREATE POLICY "item-images service delete" ON storage.objects
  FOR DELETE TO service_role USING (bucket_id = 'item-images');
