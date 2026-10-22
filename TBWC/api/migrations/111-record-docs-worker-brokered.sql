-- record-docs: permission logic moves out of the database, into the Worker.
--
-- 2026-10-22: a user on a custom role (made in Settings > Roles) could see an
-- order and its Documents tab but every file click failed with "Object not
-- found". The bucket's RLS (migration 091, can_access_record_doc) hard-coded
-- its own idea of access — admin, users.type = 'employee', or the order's own
-- rep — and never looked at role_permission, so it disagreed with the Worker
-- the moment a role wasn't one of the seeded ones. Custom roles get created
-- often; each one would have needed a migration.
--
-- The browser no longer calls this bucket with its own token. The Worker's
-- /api/documents/storage/* routes authorize against the caller's resolved
-- permissions (the same checks as the metadata routes) and mint signed
-- view/upload URLs with the service-role key (worker/storageAdmin.ts).
-- storage.objects keeps RLS enabled with NO policy for record-docs, so
-- authenticated/anon get nothing and only service_role (which bypasses RLS)
-- touches it. No permission logic lives here any more.
--
-- Apply ONLY after the Worker + frontend that use /documents/storage/* are
-- deployed — before that, the live frontend still uploads/opens directly and
-- would lose access.

DROP POLICY IF EXISTS "record-docs authenticated read" ON storage.objects;
DROP POLICY IF EXISTS "record-docs authenticated insert" ON storage.objects;
DROP POLICY IF EXISTS "record-docs authenticated update" ON storage.objects;
DROP POLICY IF EXISTS "record-docs authenticated delete" ON storage.objects;

-- Only the dropped policies used these (migration 091).
DROP FUNCTION IF EXISTS public.can_access_record_doc(text);
DROP FUNCTION IF EXISTS public.is_full_access_staff();
DROP FUNCTION IF EXISTS public.visible_rep_list_ids();
