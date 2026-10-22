-- rep-docs (Resources): permission logic moves out of the database, into the
-- Worker — same move as migration 111 made for record-docs.
--
-- The portal's Resources tab now lists/uploads/moves/deletes/opens files only
-- through /api/doc-types/storage/*, which checks resource:read/resource:write
-- and the employee-only document_type (folder types inherited) in code, then
-- acts with the service-role key. These policies were the database's own copy
-- of that rule (is_approved_rep / is_admin / can_read_rep_doc) and keyed off
-- users.is_admin and users.approved rather than role grants, so a custom role
-- could disagree with them.
--
-- BEFORE APPLYING: the legacy tbwc-site admin.html Documents section still
-- calls this bucket directly with the user's token (sb.storage.from('rep-docs'))
-- and stops working once these are gone. Retire that page (the portal's
-- Resources tab replaces it) first. And, like 111, apply only after the Worker +
-- frontend that use /doc-types/storage/* are deployed.
--
-- is_admin() / is_approved_rep() are NOT dropped: other policies (rep_leads,
-- tbwc-site pages) may still reference them.

DROP POLICY IF EXISTS rep_docs_select ON storage.objects;
DROP POLICY IF EXISTS rep_docs_insert ON storage.objects;
DROP POLICY IF EXISTS rep_docs_update ON storage.objects;
DROP POLICY IF EXISTS rep_docs_delete ON storage.objects;

DROP FUNCTION IF EXISTS public.can_read_rep_doc(text);
