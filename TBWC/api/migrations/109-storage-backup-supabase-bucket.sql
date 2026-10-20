-- storageBackup.ts (105/106/107) originally mirrored record-docs/rep-docs/
-- item-images into Cloudflare R2 — a separate vendor from Supabase, chosen
-- over a second bucket in this same project. Switching to this project's own
-- storage instead: still an independent copy (separate bucket, separate RLS,
-- survives the same "bytes missing from one bucket" failure the original
-- backup was built for), reuses the SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
-- already configured (no new secret), and R2 needing to be enabled through
-- the Cloudflare dashboard first was blocking every deploy.
--
-- Buckets are plain storage.buckets rows (see migration 026's record-docs for
-- the same pattern) — no RLS policies needed: this bucket is never read by a
-- browser, only by the Worker's service-role key, which bypasses RLS.
INSERT INTO storage.buckets (id, name, public)
SELECT 'storage-backup', 'storage-backup', false
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'storage-backup');
