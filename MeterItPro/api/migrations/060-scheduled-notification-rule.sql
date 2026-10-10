-- Scheduled AI-drafted notifications. Framework module:
-- framework/backend/api/base/scheduledNotifications.ts, framework/backend/db/scheduled-notification.sql.
--
-- Multi-tenant: tenant_id scopes each rule the same way public.notification
-- does, and the cron handler (worker/index.ts scheduled()) evaluates every
-- tenant's active rules on each tick — see runAllActiveNotificationRules for
-- the existing analog. users_id bigint, matching public.users.id.

CREATE TABLE IF NOT EXISTS public.scheduled_notification_rule (
  scheduled_notification_rule_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      bigint NOT NULL,
  name           varchar(200) NOT NULL,
  schedule_cron  varchar(100) NOT NULL,
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
ALTER TABLE public.scheduled_notification_rule ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.scheduled_notification_rule TO postgres;
GRANT ALL ON TABLE public.scheduled_notification_rule TO service_role;
