-- Adds an 'off' tier to public.scheduled_job (103) — the stop switch for a
-- scheduled job, asked for as "can I have a button to stop the backup".
--
-- 'off' is not a Cloudflare Cron Trigger tier (wrangler.toml has no cron for
-- it, and cronMonitor.ts's TIER_CRON deliberately covers only the runnable
-- tiers), so a job parked here is simply never named by jobsForTier() and
-- never runs. Reusing the tier column rather than adding a separate
-- `enabled` boolean keeps one source of truth: there is no state where the
-- tier says nightly but a second flag says paused.
--
-- The same row is ALSO the mid-run kill switch: backupStorageToR2() re-reads
-- it every CANCEL_CHECK_EVERY objects (storageBackup.ts) and bails out when
-- it reads 'off', so flipping the switch stops a tick already in progress at
-- the next batch boundary instead of only taking effect from the next tick.
--
-- Resume (Settings > Storage Backup's Resume button) writes 'nightly' back,
-- the documented default from 106 — the prior tier is not remembered, so a
-- temporary 'hourly' catch-up has to be re-picked from the Scheduled Jobs
-- tier dropdown after a pause/resume.

ALTER TABLE public.scheduled_job DROP CONSTRAINT IF EXISTS scheduled_job_tier_check;
ALTER TABLE public.scheduled_job ADD CONSTRAINT scheduled_job_tier_check
  CHECK (cron_tier IN ('frequent', 'hourly', 'daily', 'nightly', 'off'));
