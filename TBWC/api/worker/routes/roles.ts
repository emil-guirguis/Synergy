/**
 * Role management for Settings > Roles.
 *
 *   GET    /            -> every role with its grants
 *   GET    /catalog     -> the permission strings this app enforces
 *   POST   /            -> create a role
 *   PUT    /:id         -> rename a role
 *   PUT    /:id/grants  -> replace a role's grants wholesale
 *   DELETE /:id         -> delete a role
 *
 * Thin Hono wrapper over the framework module
 * (@meterit/framework-backend/api/base/roles) — this file owns only what is
 * TBWC-specific: auth middleware, the permission catalog, and the response
 * envelope. TBWC has no tenant concept, so tenantId is always null — see that
 * module's header for what that means for role visibility/ownership.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission, clearPermissionCache } from '../middleware';
import { PERMISSIONS } from '../permissions';
import {
  listRoles,
  createRole,
  renameRole,
  saveGrants,
  deleteRole,
  RoleValidationError,
  RoleConflictError,
  RoleNotFoundError,
} from '@meterit/framework-backend/api/base/roles';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

/** Map the framework's typed errors to the right status code; anything else bubbles to the 500 handler. */
function fail(c: any, e: unknown) {
  if (e instanceof RoleValidationError) return c.json({ success: false, message: e.message }, 400);
  if (e instanceof RoleConflictError) return c.json({ success: false, message: e.message }, 409);
  if (e instanceof RoleNotFoundError) return c.json({ success: false, message: e.message }, 404);
  throw e;
}

app.get('/', requirePermission('role:read'), async (c) => {
  const items = await listRoles(execQuery, c.env, null);
  return c.json({ success: true, data: { items } });
});

app.get('/catalog', requirePermission('role:read'), (c) =>
  c.json({ success: true, data: { permissions: PERMISSIONS } }));

app.post('/', requirePermission('role:write'), async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  try {
    const created = await createRole(execQuery, c.env, null, body, PERMISSIONS);
    clearPermissionCache();
    return c.json({ success: true, data: created });
  } catch (e) {
    return fail(c, e);
  }
});

app.put('/:id', requirePermission('role:write'), async (c) => {
  const name = (await c.req.json().catch(() => ({} as any)))?.name;
  try {
    const role = await renameRole(execQuery, c.env, c.req.param('id'), null, name);
    return c.json({ success: true, data: role });
  } catch (e) {
    return fail(c, e);
  }
});

app.put('/:id/grants', requirePermission('role:write'), async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  try {
    const result = await saveGrants(execQuery, c.env, c.req.param('id'), null, body?.grants, PERMISSIONS);
    // Grants are cached per role for a minute; drop it so an edit takes effect
    // on the next request rather than whenever the TTL happens to lapse.
    clearPermissionCache();
    return c.json({ success: true, data: result });
  } catch (e) {
    return fail(c, e);
  }
});

app.delete('/:id', requirePermission('role:write'), async (c) => {
  try {
    const result = await deleteRole(execQuery, c.env, c.req.param('id'), null);
    clearPermissionCache();
    return c.json({ success: true, data: result });
  } catch (e) {
    return fail(c, e);
  }
});

export default app;
