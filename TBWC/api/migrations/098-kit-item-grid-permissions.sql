-- TBWC migration 098 — Inventory > Kit Items grid gets its own permissions.
--
-- /api/inventory/:id/kit-items was guarded by inventory:read / inventory:write;
-- it's now the inventoryGridKitItem child grid (inventoryGridKitItemSchema.ts,
-- permissions derived via permissions.ts CHILD_SCHEMAS). The PUT still takes
-- the whole list but requires create/delete/write for the adds/removes/edits
-- it contains (inventory.ts diffKitItems). Day-one access unchanged:
--   inventory:read  -> inventoryGridKitItem:read
--   inventory:write -> inventoryGridKitItem:create, :write, :delete
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, 'inventoryGridKitItem:read', rp.scope
  FROM public.role_permission rp
 WHERE rp.permission = 'inventory:read'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, a.permission, rp.scope
  FROM public.role_permission rp
 CROSS JOIN (VALUES ('inventoryGridKitItem:create'), ('inventoryGridKitItem:write'), ('inventoryGridKitItem:delete')) AS a(permission)
 WHERE rp.permission = 'inventory:write'
ON CONFLICT (role_id, permission) DO NOTHING;
