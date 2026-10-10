-- Scheduled AI-drafted notifications. Framework module:
-- framework/backend/api/base/scheduledNotifications.ts, framework/backend/db/scheduled-notification.sql.
--
-- TBWC is single-tenant (see middleware.ts), so like 060-notifications.sql
-- this drops tenant_id entirely — runScheduledNotifications is called with
-- `{ tenantColumn: null }`. users_id is uuid, matching public.users.id
-- (Supabase Auth). A row with users_id NULL is a broadcast, visible to every
-- signed-in user (same visibility rule as public.notification).

CREATE TABLE IF NOT EXISTS public.scheduled_notification_rule (
  scheduled_notification_rule_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           varchar(200) NOT NULL,
  schedule_cron  varchar(100) NOT NULL,
  prompt         text NOT NULL,
  users_id       uuid NULL,
  severity       varchar(20) NOT NULL DEFAULT 'info'
    CONSTRAINT scheduled_notification_rule_severity_check CHECK (severity IN ('info', 'warning', 'error')),
  active         boolean NOT NULL DEFAULT true,
  last_run_at    timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_scheduled_notification_rule_active ON public.scheduled_notification_rule (active);

ALTER TABLE public.scheduled_notification_rule OWNER TO postgres;
ALTER TABLE public.scheduled_notification_rule ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.scheduled_notification_rule TO postgres;
GRANT ALL ON TABLE public.scheduled_notification_rule TO service_role;
