-- TBWC migration 100 — each module's Documents grid gets its own permissions.
--
-- document:read / document:write was one flat grant over every module's
-- attachments. Now each module's Documents tab is its own child grid
-- (framework documentGridSchema, registered in permissions.ts CHILD_SCHEMAS):
--   orderGridDocument / quoteGridDocument / invoiceGridDocument /
--   inventoryGridDocument / supportGridDocument  :read/create/write/delete
-- enforced per document row's entity_type in routes/documents.ts.
--
-- Day-one access unchanged:
--   document:read  -> <module>GridDocument:read                (same scope)
--   document:write -> <module>GridDocument:create/write/delete (same scope)
-- Quotes additionally required quote:read / quote:write (and honoured its
-- 'own' scope), so quoteGridDocument is granted only where both are held,
-- at the quote grant's scope.
--
-- document:* rows are left in place — the previously-deployed Worker still
-- checks them. 101 removes them; apply it AFTER the new Worker is live.

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, g.key || ':read', rp.scope
  FROM public.role_permission rp
 CROSS JOIN (VALUES ('orderGridDocument'), ('invoiceGridDocument'), ('inventoryGridDocument'), ('supportGridDocument')) AS g(key)
 WHERE rp.permission = 'document:read'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, g.key || ':' || a.action, rp.scope
  FROM public.role_permission rp
 CROSS JOIN (VALUES ('orderGridDocument'), ('invoiceGridDocument'), ('inventoryGridDocument'), ('supportGridDocument')) AS g(key)
 CROSS JOIN (VALUES ('create'), ('write'), ('delete')) AS a(action)
 WHERE rp.permission = 'document:write'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT q.role_id, 'quoteGridDocument:read', q.scope
  FROM public.role_permission q
  JOIN public.role_permission d ON d.role_id = q.role_id AND d.permission = 'document:read'
 WHERE q.permission = 'quote:read'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT q.role_id, 'quoteGridDocument:' || a.action, q.scope
  FROM public.role_permission q
  JOIN public.role_permission d ON d.role_id = q.role_id AND d.permission = 'document:write'
 CROSS JOIN (VALUES ('create'), ('write'), ('delete')) AS a(action)
 WHERE q.permission = 'quote:write'
ON CONFLICT (role_id, permission) DO NOTHING;
