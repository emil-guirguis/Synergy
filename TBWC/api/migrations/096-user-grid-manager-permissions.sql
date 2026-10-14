-- TBWC migration 096 — Users > Manages grid gets its own permissions.
--
-- /api/user-managers was guarded by user:read / user:write; it's now a
-- child-row grid (userGridManagerSchema.ts, permissions derived via
-- permissions.ts CHILD_SCHEMAS) guarded by userGridManager:read/create/delete
-- (no write — a row is only ever added or removed). Day-one access unchanged:
--   user:read  -> userGridManager:read
--   user:write -> userGridManager:create, userGridManager:delete
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, 'userGridManager:read', rp.scope
  FROM public.role_permission rp
 WHERE rp.permission = 'user:read'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, a.permission, rp.scope
  FROM public.role_permission rp
 CROSS JOIN (VALUES ('userGridManager:create'), ('userGridManager:delete')) AS a(permission)
 WHERE rp.permission = 'user:write'
ON CONFLICT (role_id, permission) DO NOTHING;
