-- Storage object backup — mirrors Supabase Storage bucket objects (file
-- bytes, not just the storage.objects metadata row) into a Cloudflare R2
-- bucket, since Supabase's own daily physical backups cover Postgres only
-- (confirmed via `supabase backups list`) and never touch the actual files
-- sitting in record-docs/rep-docs/item-images. See worker/storageBackup.ts.
--
-- storage_backup_object: ledger of what's already been mirrored, keyed by
-- (bucket, storage_path). The backup job (worker/index.ts's scheduled(),
-- tier 'hourly') reads storage.objects LEFT JOIN this table to find objects
-- it hasn't copied yet, processes one bounded batch per tick (subrequest-
-- limit safe), and inserts a row here on success — same resumable-by-ledger
-- shape as cron_run_log (102)/scheduled_job (103), not a bulk one-shot job.
-- Run history/status (ok/error/duration) for the job itself reuses the
-- existing cron_run_log table (job_name 'backupStorage') rather than a
-- parallel log table — runJob() in cronMonitor.ts already provides that.

CREATE TABLE IF NOT EXISTS public.storage_backup_object (
  storage_backup_object_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket        varchar(100) NOT NULL,
  storage_path  text NOT NULL,
  bytes         bigint,
  backed_up_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_backup_object_bucket_path_uniq UNIQUE (bucket, storage_path)
) TABLESPACE pg_default;

-- backupStorage's "what's left" query filters storage.objects by bucket_id
-- and anti-joins this table on (bucket, storage_path) — index the join/filter
-- columns together so that anti-join stays an index lookup as the ledger grows
-- toward the full object count (11k+ already in record-docs alone).
CREATE INDEX IF NOT EXISTS idx_storage_backup_object_bucket_path ON public.storage_backup_object (bucket, storage_path);

ALTER TABLE public.storage_backup_object OWNER TO postgres;
ALTER TABLE public.storage_backup_object ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.storage_backup_object TO postgres;
GRANT ALL ON TABLE public.storage_backup_object TO service_role;

-- Register the job on the existing scheduled_job tier mechanism (103) so it
-- shows up in Settings > Scheduled Jobs immediately and can be retiered from
-- there with no redeploy. 'hourly' balances catch-up speed for the ~13GB/
-- 11.4k-object backlog already in record-docs against the Worker's per-
-- invocation subrequest cap (see storageBackup.ts's BATCH_SIZE comment).
INSERT INTO public.scheduled_job (job_name, cron_tier) VALUES
  ('backupStorage', 'hourly')
ON CONFLICT (job_name) DO NOTHING;
