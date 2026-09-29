-- TBWC migration 054 — rep-docs (Rep Portal "Resources") bucket RLS policies.
--
-- COPY of tbwc-site/scripts/schema.sql lines ~208-241 (canonical — that repo owns
-- the bucket + the is_admin()/is_approved_rep() helper functions, shared with
-- portal.html/admin.html). Never captured here before the 2026-09-29 Supabase
-- region migration (ca-central-1 -> us-west-1), which dropped every
-- storage.objects policy project-wide (see 026/027 for the same gap on
-- record-docs/item-images). Copied in now so a future project move can replay it
-- from this repo instead of hand-reconstructing from Studio/tbwc-site again.

-- Is the CURRENT auth user an approved rep? security definer bypasses RLS.
CREATE OR REPLACE FUNCTION public.is_approved_rep()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$ SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND type = 'rep' AND approved); $$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$ SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND is_admin); $$;

-- Private bucket (public = false => no anonymous object access). Row already
-- exists post-migration (storage.buckets rows survived the cutover) but keep
-- the INSERT so this file is replayable standalone.
INSERT INTO storage.buckets (id, name, public)
SELECT 'rep-docs', 'rep-docs', false
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'rep-docs');

-- Approved reps (and admins) may list objects + mint signed URLs.
DROP POLICY IF EXISTS rep_docs_select ON storage.objects;
CREATE POLICY rep_docs_select ON storage.objects
  FOR SELECT USING (
    bucket_id = 'rep-docs' AND (public.is_approved_rep() OR public.is_admin())
  );

-- Only admins may upload / overwrite / delete documents.
DROP POLICY IF EXISTS rep_docs_insert ON storage.objects;
CREATE POLICY rep_docs_insert ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'rep-docs' AND public.is_admin());

DROP POLICY IF EXISTS rep_docs_update ON storage.objects;
CREATE POLICY rep_docs_update ON storage.objects
  FOR UPDATE USING (bucket_id = 'rep-docs' AND public.is_admin())
  WITH CHECK (bucket_id = 'rep-docs' AND public.is_admin());

DROP POLICY IF EXISTS rep_docs_delete ON storage.objects;
CREATE POLICY rep_docs_delete ON storage.objects
  FOR DELETE USING (bucket_id = 'rep-docs' AND public.is_admin());
