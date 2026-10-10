-- ===== Canonical `scheduled_notification_rule` table (framework-owned) =====
-- Cron-scheduled, AI-drafted notifications. Backs
-- framework/backend/api/base/scheduledNotifications.ts's runScheduledNotifications(),
-- called from each app's Worker scheduled() handler. Each row names a
-- schedule_cron (5-field, UTC) and a free-text `prompt` describing what to
-- write about; when the cron matches the current tick, Claude drafts a
-- {title, description} from the prompt and it's inserted into
-- public.notification (users_id NULL = broadcast to everyone).
--
-- Consuming apps copy this file into their own migrations dir and adapt the
-- two ID-shaped columns to match how that app identifies users/tenants, same
-- as notification.sql:
--   - MeterItPro: tenant_id bigint (multi-tenant), users_id bigint.
--   - TBWC: single-tenant, so tenant_id is dropped entirely (pass
--     `tenantColumn: null` to runScheduledNotifications) and users_id is
--     uuid, matching public.users.id (Supabase Auth).
-- Naming convention: {tablename}_id primary key.

CREATE TABLE IF NOT EXISTS public.scheduled_notification_rule (
  scheduled_notification_rule_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      bigint NOT NULL,
  name           varchar(200) NOT NULL,
  -- 5-field cron expression, UTC, matched by matchesCronSchedule().
  schedule_cron  varchar(100) NOT NULL,
  -- What to tell Claude to write about, e.g. "Remind the sales team to log
  -- their weekly activity, Friday afternoon tone."
  prompt         text NOT NULL,
  users_id       bigint NULL,
  severity       varchar(20) NOT NULL DEFAULT 'info'
    CONSTRAINT scheduled_notification_rule_severity_check CHECK (severity IN ('info', 'warning', 'error')),
  active         boolean NOT NULL DEFAULT true,
  last_run_at    timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_scheduled_notification_rule_active ON public.scheduled_notification_rule (active);
CREATE INDEX IF NOT EXISTS idx_scheduled_notification_rule_tenant ON public.scheduled_notification_rule (tenant_id);

ALTER TABLE public.scheduled_notification_rule OWNER TO postgres;
-- Worker connects as postgres (table owner, bypasses RLS). RLS on + no
-- policies means PostgREST roles get nothing: reads go through the app's own
-- API, which applies its own auth. Mirrors notification.sql.
ALTER TABLE public.scheduled_notification_rule ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.scheduled_notification_rule TO postgres;
GRANT ALL ON TABLE public.scheduled_notification_rule TO service_role;
