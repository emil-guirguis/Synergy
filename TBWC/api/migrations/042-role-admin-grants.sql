-- Role management permissions for the Settings > Roles tab.
--
-- Admin only, and deliberately not folded into setting:write: anyone who can
-- edit roles can grant themselves every other permission, so it has to be
-- possible to let someone manage org settings without also handing them the
-- keys to the permission model.
INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT r.role_id, p.permission, 'all', ARRAY[]::text[]
  FROM public.role r
 CROSS JOIN (VALUES ('role:read'), ('role:write')) AS p(permission)
 WHERE r.tenant_id IS NULL AND r.code = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;
