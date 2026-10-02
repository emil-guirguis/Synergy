-- In-app notification bell (header). Framework module:
-- framework/backend/api/base/notifications.ts, framework/backend/db/notification.sql.
--
-- TBWC is single-tenant (see middleware.ts), so unlike the canonical template
-- this drops tenant_id entirely — every notifications.ts call passes
-- `{ tenantColumn: null }`. users_id/acknowledged_by are uuid, matching
-- public.users.id (Supabase Auth), not the bigint MeterItPro uses.
-- A row with users_id NULL is a broadcast, visible to every signed-in user.

CREATE TABLE IF NOT EXISTS public.notification (
  notification_id    bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  users_id            uuid NULL,
  notification_type   varchar(50) NOT NULL,
  severity             varchar(20) NOT NULL DEFAULT 'warning',
  title               varchar(255) NOT NULL,
  description         text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  status              varchar(15) NOT NULL DEFAULT 'open'
    CONSTRAINT notification_status_check CHECK (status IN ('open', 'acknowledged')),
  first_detected_at   timestamptz DEFAULT now(),
  acknowledged_at     timestamptz,
  acknowledged_by     uuid
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_notification_users ON public.notification (users_id);
CREATE INDEX IF NOT EXISTS idx_notification_created_at ON public.notification (created_at DESC);

ALTER TABLE public.notification OWNER TO postgres;
-- Worker connects as postgres (table owner, bypasses RLS). RLS on + no
-- policies means PostgREST roles get nothing: reads go through the app's own
-- API, which applies its own auth. Mirrors 026-documents.sql.
ALTER TABLE public.notification ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.notification TO postgres;
GRANT ALL ON TABLE public.notification TO service_role;
