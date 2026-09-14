/**
 * MeterItPro's permission catalog — every `module:action` string the routes
 * actually enforce, gathered from the requirePermission() calls themselves.
 *
 * The framework ignores any granted permission missing from this list, so a
 * role can't be handed something no route checks. That mattered here: the old
 * in-code role map (users.ts ROLE_PERMISSIONS) granted building:* and
 * equipment:*, which nothing enforces, while omitting dashboard, email and
 * notification, which 30-odd routes do enforce.
 *
 * is_super_admin / is_support_admin stay outside this model: they are
 * platform-operator flags for cross-tenant administration (see adminRoutes.ts),
 * not a role a tenant can be given.
 */
export const PERMISSIONS = [
  'dashboard:admin',
  'dashboard:create',
  'dashboard:delete',
  'dashboard:read',
  'dashboard:update',
  'contact:create',
  'contact:delete',
  'contact:read',
  'contact:update',
  'device:read',
  'email:read',
  'email:send',
  'location:create',
  'location:delete',
  'location:read',
  'location:update',
  'meter:create',
  'meter:delete',
  'meter:read',
  'meter:update',
  'notification:read',
  'notification:send',
  'settings:read',
  'settings:update',
  'template:create',
  'template:delete',
  'template:read',
  'template:update',
  'user:create',
  'user:delete',
  'user:read',
  'user:update',
  // Managing the roles themselves. Separate from settings:update because
  // role:write lets its holder grant themselves everything else.
  'role:read',
  'role:write',
] as const;

export type MipPermission = (typeof PERMISSIONS)[number];
