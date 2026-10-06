-- Role management (Settings > Roles) is gated by setting:read/setting:write
-- directly now — see routes/roles.ts — not its own role:read/role:write
-- permission (migration 042 originally kept them separate specifically so
-- Settings access could be handed out without the keys to the permission
-- model; that separation isn't wanted here, so dropped).
DELETE FROM public.role_permission WHERE permission IN ('role:read', 'role:write');
