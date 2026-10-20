-- cron_run_log (102) records status/duration per run but discards whatever
-- the job itself actually did (documents indexed, files copied) — runJob()
-- only ever called fn() for its side effects. Settings > Scheduled Jobs and
-- Storage Backup's history tables both want that count alongside duration,
-- so give runJob() somewhere to put it: a free-form per-job-name shape
-- (backfillDocumentIndex: {indexed, attempted}; backupStorage: {copied,
-- failed}), not a fixed column, since each job's "what it did" differs.

ALTER TABLE public.cron_run_log ADD COLUMN IF NOT EXISTS detail jsonb;
