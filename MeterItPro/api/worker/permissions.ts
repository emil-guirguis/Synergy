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
  // Role management (Settings > Roles) is gated by settings:read/
  // settings:update directly — see routes/roles.ts — not its own permission.
] as const;

export type MipPermission = (typeof PERMISSIONS)[number];

/**
 * The only accounts allowed to use "log in as this user" (routes/users.ts
 * /:id/impersonate). Not a permission and not a role — impersonation mints a
 * session for any user in any tenant, which is more power than any role grants,
 * so the list lives in code where widening it is a reviewable diff. Mirrors
 * TBWC/api/worker/permissions.ts IMPERSONATE_ALLOWED_EMAILS.
 */
export const IMPERSONATE_ALLOWED_EMAILS: readonly string[] = [
  'emilguirguis@yahoo.com', // Emil Guirguis
];
