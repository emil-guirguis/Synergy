-- Per-field view/edit, additive alongside hidden_fields (framework/backend/db/role.sql,
-- framework/backend/api/base/permissions.ts). hidden_fields stays exactly as
-- it is today — nothing here touches an existing row — field_access is just
-- a second, richer way to express the same idea (plus edit, which
-- hidden_fields never had) that the Settings > Roles field-security grid
-- writes going forward. Same column, same migration, as TBWC's
-- 064-field-access.sql — this is shared framework code, so both apps' DBs
-- need it or permissions.ts's loadGrants query breaks for whichever one doesn't.
ALTER TABLE public.role_permission
  ADD COLUMN IF NOT EXISTS field_access jsonb NOT NULL DEFAULT '{}'::jsonb;
