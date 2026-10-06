-- Role management (Settings > Roles) is gated by settings:read/
-- settings:update directly now — see routes/roles.ts — not its own
-- role:read/role:write permission (migration 053 originally kept them
-- separate specifically so Settings access could be handed out without the
-- keys to the permission model; that separation isn't wanted here, so dropped).
DELETE FROM public.role_permission WHERE permission IN ('role:read', 'role:write');
