-- Closes the Storage RLS hole found in the 2026-10-12 RBAC audit: every
-- record-docs policy (migrations/026-documents.sql) checked only
-- `bucket_id = 'record-docs'` — ANY authenticated user could read/write/
-- delete ANY object, since the browser talks to Supabase Storage directly
-- (storageService.ts), never through the Worker's own order:read/quote:read/
-- etc. scope checks. Same gap on rep-docs (migrations/054) for the
-- 'employee'-only doc_type split: any approved rep could read every object,
-- including ones the app's UI hides from them.
--
-- These functions are a coarse backstop, not a full replica of the dynamic
-- role_permission system the Worker enforces (see framework/backend/api/base/
-- permissions.ts): admin and users.type='employee' get full access, matching
-- migrations 039/040's actual current grants (employee holds order/quote/
-- invoice/document read+write at 'all' scope today). If a future admin
-- reconfigures employee's scope down via Settings > Roles, these functions
-- would NOT follow that change automatically — they'd need a matching
-- update. Rep/customer ownership (order/quote/invoice) mirrors
-- middleware.ts's visibleRepListIds(user) exactly (self + every managed
-- user's rep), which IS stable — that part isn't a simplification.

-- Every rep list_id this caller may act as: their own linked rep, plus every
-- user they manage's (public.user_manager) — mirrors middleware.ts's
-- visibleRepListIds(user) so RLS and the Worker agree on "own" means the same
-- rows. Empty array (not null) when unlinked and managing nobody.
CREATE OR REPLACE FUNCTION public.visible_rep_list_ids()
RETURNS text[]
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT list_id) FILTER (WHERE list_id IS NOT NULL), ARRAY[]::text[])
    FROM (
      SELECT sr.list_id
        FROM public.users u
        LEFT JOIN public.qb_sales_rep sr ON sr.qb_sales_rep_id = u.qb_sales_rep_id
       WHERE u.id = auth.uid()
      UNION ALL
      SELECT msr.list_id
        FROM public.user_manager um
        JOIN public.users mu ON mu.id = um.managed_user_id
        JOIN public.qb_sales_rep msr ON msr.qb_sales_rep_id = mu.qb_sales_rep_id
       WHERE um.manager_id = auth.uid()
    ) ids;
$$;

-- Admin or employee — the "sees everything" tier per migrations 039/040. See
-- the file header's caveat: this does NOT track a future per-role scope edit.
CREATE OR REPLACE FUNCTION public.is_full_access_staff()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$ SELECT public.is_admin() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND type = 'employee'); $$;

-- record-docs object paths are "<entityType>/<entityId>/<file>" (see
-- framework/backend/api/base/documents.ts's storagePrefix). Ownership per
-- entity_type:
--   order/quote/invoice - the row's sales_rep_list_id must be one of the
--     caller's visible_rep_list_ids() (self + managed reps) — matches
--     orders.ts/quotes.ts/invoices.ts's own scopeOf('*:read')==='own' check.
--   inventory - no per-rep ownership concept, non-sensitive (cutsheets/
--     product photos); matches documents.ts's own current behavior (no
--     extra scoping there either) — any authenticated caller.
--   support_ticket - the ticket's filer or assignee, mirrors documents.ts's
--     ownsSupportTicket().
--   anything else (a future entity_type added without updating this
--     function) - fails closed rather than silently allowing it.
CREATE OR REPLACE FUNCTION public.can_access_record_doc(object_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  object_entity_type text := split_part(object_name, '/', 1);
  object_entity_id   text := split_part(object_name, '/', 2);
BEGIN
  IF public.is_full_access_staff() THEN
    RETURN true;
  END IF;

  IF object_entity_type = 'inventory' THEN
    RETURN true;
  END IF;

  IF object_entity_type = 'order' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.qb_sales_order o
       WHERE o.qb_sales_order_id::text = object_entity_id
         AND o.sales_rep_list_id = ANY(public.visible_rep_list_ids())
    );
  END IF;

  IF object_entity_type = 'quote' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.quote q
       WHERE q.quote_id::text = object_entity_id
         AND q.sales_rep_list_id = ANY(public.visible_rep_list_ids())
    );
  END IF;

  IF object_entity_type = 'invoice' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.qb_invoice i
       WHERE i.qb_invoice_id::text = object_entity_id
         AND i.sales_rep_list_id = ANY(public.visible_rep_list_ids())
    );
  END IF;

  IF object_entity_type = 'support_ticket' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.support_ticket t
       WHERE t.support_ticket_id::text = object_entity_id
         AND (t.users_id = auth.uid() OR t.assigned_to_users_id = auth.uid())
    );
  END IF;

  RETURN false;
END;
$$;

DROP POLICY IF EXISTS "record-docs authenticated read" ON storage.objects;
CREATE POLICY "record-docs authenticated read" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'record-docs' AND public.can_access_record_doc(name));

DROP POLICY IF EXISTS "record-docs authenticated insert" ON storage.objects;
CREATE POLICY "record-docs authenticated insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'record-docs' AND public.can_access_record_doc(name));

DROP POLICY IF EXISTS "record-docs authenticated update" ON storage.objects;
CREATE POLICY "record-docs authenticated update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'record-docs' AND public.can_access_record_doc(name))
  WITH CHECK (bucket_id = 'record-docs' AND public.can_access_record_doc(name));

DROP POLICY IF EXISTS "record-docs authenticated delete" ON storage.objects;
CREATE POLICY "record-docs authenticated delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'record-docs' AND public.can_access_record_doc(name));

-- rep-docs: the existing SELECT policy (migrations/054) only checked
-- is_approved_rep() OR is_admin() — never doc_type, so any approved rep could
-- read 'employee'-only resources the app's UI hides from them. Walks from the
-- object's own path up through each parent folder looking for a
-- public.rep_doc_type row (a type can be set on a folder, inherited by
-- everything under it — mirrors ResourcesTab.tsx's typeOf()); no row
-- anywhere up the chain defaults to 'all', same as the frontend. Write
-- policies (insert/update/delete, admin-only) are unchanged — already
-- correct.
CREATE OR REPLACE FUNCTION public.can_read_rep_doc(object_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  effective_type text;
  p text := object_name;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;
  IF NOT public.is_approved_rep() THEN
    RETURN false;
  END IF;

  LOOP
    SELECT doc_type INTO effective_type FROM public.rep_doc_type WHERE doc_path = p;
    EXIT WHEN effective_type IS NOT NULL;
    EXIT WHEN position('/' in p) = 0;
    p := regexp_replace(p, '/[^/]*$', '');
  END LOOP;

  RETURN COALESCE(effective_type, 'all') != 'employee';
END;
$$;

DROP POLICY IF EXISTS rep_docs_select ON storage.objects;
CREATE POLICY rep_docs_select ON storage.objects
  FOR SELECT USING (
    bucket_id = 'rep-docs' AND public.can_read_rep_doc(name)
  );
