-- Visibility + config for the Worker's scheduled() cron jobs (worker/index.ts),
-- shown on Settings > Scheduled Jobs. Born from debugging a QBWC-down alert
-- that silently stopped firing: backfillDocumentIndex's PDF/docx/xlsx parsing
-- was eating the whole tick's CPU budget before checkQbwcStale could run, and
-- there was no record anywhere that it had even started — only `wrangler tail`,
-- watched live, caught it.
--
-- cron_run_log: one row per job per tick, written at start (status 'running')
-- and updated at finish ('ok'/'error'). A row stuck at 'running' long after
-- its job's own schedule should have produced a finish is itself the signature
-- of an invocation dying mid-job (CPU limit, uncaught throw before the finish
-- UPDATE) — exactly what was invisible before this table existed.
--
-- alert_setting: per-alert config (recipients, email on/off, threshold) that
-- staleAlert.ts (and future deterministic checks) reads instead of hardcoded
-- constants, editable from Settings without a redeploy. Deliberately separate
-- from scheduled_notification_rule (086) — that table is free-text AI-drafted
-- messages on a user-defined cron; this is structured config for a fixed,
-- deterministic, code-driven check and has no cron of its own (the check still
-- runs on whatever Cloudflare Cron Trigger schedule.ts's job is wired to).

CREATE TABLE IF NOT EXISTS public.cron_run_log (
  cron_run_log_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name     varchar(100) NOT NULL,
  status       varchar(10) NOT NULL DEFAULT 'running'
    CONSTRAINT cron_run_log_status_check CHECK (status IN ('running', 'ok', 'error')),
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  integer
) TABLESPACE pg_default;

-- Dashboard's main query: latest row per job. (job_name, started_at DESC)
-- serves both that and the paged history view with one index.
CREATE INDEX IF NOT EXISTS idx_cron_run_log_job_started ON public.cron_run_log (job_name, started_at DESC);

ALTER TABLE public.cron_run_log OWNER TO postgres;
ALTER TABLE public.cron_run_log ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.cron_run_log TO postgres;
GRANT ALL ON TABLE public.cron_run_log TO service_role;

CREATE TABLE IF NOT EXISTS public.alert_setting (
  alert_setting_id    bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_key           varchar(100) NOT NULL,
  enabled              boolean NOT NULL DEFAULT true,
  notify_email         boolean NOT NULL DEFAULT true,
  notify_inapp         boolean NOT NULL DEFAULT true,
  -- Meaning is per alert_key (for 'qbwc_stale': minutes of silence before
  -- it's considered down). NULL = the check's own built-in default.
  threshold_minutes    integer,
  throttle_hours       numeric(6, 2) NOT NULL DEFAULT 1,
  -- Fallback recipient set: everyone holding this permission. NULL = the
  -- check's own built-in default permission.
  recipient_permission varchar(100),
  -- Explicit recipients on top of (not instead of) the permission above —
  -- uuid, matching public.users.id (see 086's note on this same point).
  recipient_user_ids   uuid[] NOT NULL DEFAULT '{}',
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_setting_key_uniq UNIQUE (alert_key)
) TABLESPACE pg_default;

ALTER TABLE public.alert_setting OWNER TO postgres;
ALTER TABLE public.alert_setting ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.alert_setting TO postgres;
GRANT ALL ON TABLE public.alert_setting TO service_role;

-- Seed today's QBWC-stale behavior as explicit, editable rows instead of
-- leaving it implicit in staleAlert.ts's constants.
INSERT INTO public.alert_setting (alert_key, enabled, notify_email, notify_inapp, threshold_minutes, throttle_hours, recipient_permission)
VALUES ('qbwc_stale', true, true, true, 30, 1, 'qbsync:run')
ON CONFLICT (alert_key) DO NOTHING;
