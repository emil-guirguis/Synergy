-- Splits the Resources library (routes/docTypes.ts) off the generic
-- document:read/write permission it was wrongly sharing with order/invoice/
-- inventory file attachments (routes/documents.ts), and gives the two other
-- Utilities nav items (Rep Approvals, Notifications) their own grants for the
-- first time — they were previously gated by is_admin / always-open instead
-- of a role permission, which is why the Settings > Roles tree only ever
-- showed one "Document" leaf under Utilities instead of the sidebar's three.
--
-- Seeded to match today's actual access exactly, so no existing user's
-- access changes on deploy:
--   resource:read/write  <- mirrors each role's current document:read/write
--   notification:*       <- every seeded role, 'all' scope (the feed was
--                           wide open to any authenticated caller before)
--   repApproval:write    <- admin only (mirrors the is_admin gate it replaces)

INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT rp.role_id, 'resource:' || split_part(rp.permission, ':', 2), rp.scope, rp.hidden_fields
  FROM public.role_permission rp
 WHERE rp.permission IN ('document:read', 'document:write')
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT r.role_id, p.permission, 'all', ARRAY[]::text[]
  FROM public.role r
 CROSS JOIN (VALUES
    ('notification:read'), ('notification:write'), ('notification:delete')
  ) AS p(permission)
 WHERE r.tenant_id IS NULL AND r.code IN ('admin', 'employee', 'rep', 'customer')
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT r.role_id, 'repApproval:write', 'all', ARRAY[]::text[]
  FROM public.role r
 WHERE r.tenant_id IS NULL AND r.code = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;
