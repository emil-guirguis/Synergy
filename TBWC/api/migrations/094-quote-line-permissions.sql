-- TBWC migration 094 — quote line items get their own permissions.
--
-- Lines moved off the quote's PUT (replace-all) onto per-row child routes
-- (/api/quotes/:id/lines[/:lineId], routes/quotes.ts) guarded by
-- quoteLine:read/create/write/delete — derived in code from
-- quoteLineSchema.ts via permissions.ts's CHILD_SCHEMAS, so nothing to add to
-- a catalog table here, only grants.
--
-- Day-one behaviour is unchanged: every role keeps exactly the line access it
-- had through the quote itself, at the same scope —
--   quote:read  -> quoteLine:read
--   quote:write -> quoteLine:create, quoteLine:write, quoteLine:delete
-- After this, Settings > Roles > Quote > Line Items can tighten them per role.

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, 'quoteLine:read', rp.scope
  FROM public.role_permission rp
 WHERE rp.permission = 'quote:read'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, a.permission, rp.scope
  FROM public.role_permission rp
 CROSS JOIN (VALUES ('quoteLine:create'), ('quoteLine:write'), ('quoteLine:delete')) AS a(permission)
 WHERE rp.permission = 'quote:write'
ON CONFLICT (role_id, permission) DO NOTHING;
