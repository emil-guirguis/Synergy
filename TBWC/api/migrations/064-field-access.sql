-- Per-field view/edit, additive alongside hidden_fields (framework/backend/db/role.sql,
-- framework/backend/api/base/permissions.ts). hidden_fields stays exactly as
-- it is today — nothing here touches an existing row — field_access is just
-- a second, richer way to express the same idea (plus edit, which
-- hidden_fields never had) that the Settings > Roles field-security grid
-- writes going forward.
ALTER TABLE public.role_permission
  ADD COLUMN IF NOT EXISTS field_access jsonb NOT NULL DEFAULT '{}'::jsonb;
