-- ===== Canonical `notification` table (framework-owned) =====
-- Backs the header bell (framework/frontend/components/notifications) and the
-- CRUD/ack functions in framework/backend/api/base/notifications.ts. A row
-- with users_id NULL is a broadcast (visible to everyone in the tenant);
-- otherwise only that user sees it. notification_type/severity are free text —
-- each app defines its own vocabulary, no shared enum to keep in sync.
--
-- Consuming apps copy this file into their own migrations dir and adapt the
-- two ID-shaped columns to match how that app identifies users/tenants:
--   - MeterItPro: tenant_id bigint (multi-tenant), users_id/acknowledged_by
--     bigint (see MeterItPro/api/migrations/002-create-notification-schema.sql
--     + 046-notification-state.sql — the original this file was extracted
--     from; already live, not re-run).
--   - TBWC: single-tenant, so tenant_id is dropped entirely (pass
--     `tenantColumn: null` to every framework/backend/api/base/notifications
--     function) and users_id/acknowledged_by are uuid, matching
--     public.users.id (Supabase Auth) — see TBWC's own copy of this file.
-- Naming convention: {tablename}_id primary key.

CREATE TABLE IF NOT EXISTS public.notification (
  notification_id    bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           bigint NOT NULL,
  users_id            bigint NULL,
  notification_type   varchar(50) NOT NULL,
  severity            varchar(20) NOT NULL DEFAULT 'warning',
  title               varchar(255) NOT NULL,
  description         text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- State machine: 'open' = unacknowledged, 'acknowledged' = seen, no
  -- re-notify emails while acked. Cleared = row deleted.
  status              varchar(15) NOT NULL DEFAULT 'open'
    CONSTRAINT notification_status_check CHECK (status IN ('open', 'acknowledged')),
  first_detected_at   timestamptz DEFAULT now(),
  last_notified_at    timestamptz,
  acknowledged_at     timestamptz,
  acknowledged_by     bigint
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_notification_tenant_id ON public.notification (tenant_id);
CREATE INDEX IF NOT EXISTS idx_notification_tenant_users ON public.notification (tenant_id, users_id);
CREATE INDEX IF NOT EXISTS idx_notification_created_at ON public.notification (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_type ON public.notification (tenant_id, notification_type);

ALTER TABLE public.notification OWNER TO postgres;
-- Worker connects as postgres (table owner, bypasses RLS). RLS on + no policies
-- means PostgREST roles get nothing: reads go through the app's own API, which
-- applies the module's auth. Mirrors document.sql.
ALTER TABLE public.notification ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.notification TO postgres;
GRANT ALL ON TABLE public.notification TO service_role;
