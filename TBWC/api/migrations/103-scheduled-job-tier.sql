-- Makes worker/index.ts's job-to-schedule assignment editable from Settings >
-- Scheduled Jobs without a redeploy. Cloudflare Cron Triggers stay fixed
-- (3 tiers: */15, hourly, daily — see wrangler.toml), but which named job
-- runs on which tier is now a DB row the scheduled() handler reads each
-- invocation instead of a hardcoded if/else on the literal cron string.
-- Moving a job between tiers takes effect on its tier's next tick.
--
-- Deliberately only 3 tiers, not a free-text cron column: backfillDocumentIndex
-- is CPU-heavy (see migration 102's header and staleAlert.ts's history) and
-- sharing a tick with it is what caused the original bug this whole feature
-- exists because of. Keeping jobs confined to 3 pre-sized, non-overlapping
-- tiers is what keeps that fix intact — arbitrary custom cron per job would
-- need its own Cloudflare Cron Trigger (and a Cloudflare API token to manage
-- them) to preserve the same guarantee, which this does not attempt.

CREATE TABLE IF NOT EXISTS public.scheduled_job (
  scheduled_job_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name    varchar(100) NOT NULL,
  cron_tier   varchar(20) NOT NULL DEFAULT 'frequent'
    CONSTRAINT scheduled_job_tier_check CHECK (cron_tier IN ('frequent', 'hourly', 'daily')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_job_name_uniq UNIQUE (job_name)
) TABLESPACE pg_default;

ALTER TABLE public.scheduled_job OWNER TO postgres;
ALTER TABLE public.scheduled_job ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.scheduled_job TO postgres;
GRANT ALL ON TABLE public.scheduled_job TO service_role;

-- Seed today's hardcoded assignment (worker/index.ts) as explicit, editable rows.
INSERT INTO public.scheduled_job (job_name, cron_tier) VALUES
  ('checkQbwcStale', 'frequent'),
  ('runScheduledNotifications', 'frequent'),
  ('backfillDocumentIndex', 'hourly'),
  ('lockStaleReps', 'daily')
ON CONFLICT (job_name) DO NOTHING;
