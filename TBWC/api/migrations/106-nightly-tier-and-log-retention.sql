-- Adds a 4th Cloudflare Cron Trigger tier ('nightly', 0 10 * * * UTC = 2am
-- Pacific Standard Time; drifts to 3am Pacific during daylight saving since
-- Cron Triggers have no timezone concept, see wrangler.toml) and moves
-- backupStorage (105) onto it, per the user's "run every night at 2am" ask.
--
-- Trade-off worth remembering: backupStorage was on 'hourly' (24 ticks/day),
-- which clears the ~13GB/12.2k-object initial backlog in record-docs/
-- rep-docs/item-images in well under a day. On 'nightly' (1 tick/day) the
-- same backlog takes ~5 weeks at the same per-tick batch size (the Worker's
-- subrequest cap is per-invocation, not per-day, so fewer ticks/day just
-- means fewer batches/day). Settings > Scheduled Jobs' tier dropdown already
-- lets this be flipped back to 'hourly' temporarily to speed up a catch-up,
-- then back to 'nightly' once caught up — no code change needed either way.
--
-- Also adds pruneCronRunLog (daily tier): cron_run_log (102) has no retention
-- and grows forever (checkQbwcStale's */15 schedule alone is ~96 rows/day) —
-- this keeps the last 14 days, driving the "last 2 weeks" history the Storage
-- Backup panel shows per-run via cronMonitor.ts's recentRunsForJob.

ALTER TABLE public.scheduled_job DROP CONSTRAINT scheduled_job_tier_check;
ALTER TABLE public.scheduled_job ADD CONSTRAINT scheduled_job_tier_check
  CHECK (cron_tier IN ('frequent', 'hourly', 'daily', 'nightly'));

UPDATE public.scheduled_job SET cron_tier = 'nightly', updated_at = now()
  WHERE job_name = 'backupStorage' AND cron_tier <> 'nightly';

INSERT INTO public.scheduled_job (job_name, cron_tier) VALUES
  ('pruneCronRunLog', 'daily')
ON CONFLICT (job_name) DO NOTHING;
