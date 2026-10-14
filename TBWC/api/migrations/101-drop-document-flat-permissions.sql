-- TBWC migration 101 — drop the flat document:read / document:write grants.
--
-- APPLY ONLY AFTER the Worker with per-module Documents grid permissions
-- (migration 100, routes/documents.ts DOCUMENT_GRID_KEYS) is deployed to
-- production — until then the old Worker is what checks these rows. Once the
-- new Worker is live they're outside the permission catalog and ignored
-- (resolvePermissions drops unknown permissions), so this is housekeeping.
DELETE FROM public.role_permission WHERE permission IN ('document:read', 'document:write');
