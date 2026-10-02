/**
 * Role management for Settings > Roles.
 *
 * Thin Hono wrapper over the framework module
 * (@meterit/framework-backend/api/base/roles) — this file owns only what is
 * MeterItPro-specific: auth middleware, the permission catalog, and the
 * response envelope. Tenant-aware, unlike TBWC's equivalent: a role with
 * tenant_id NULL is a system role every tenant sees and nobody edits, and one
 * carrying a tenant_id belongs to that tenant alone — see that module's
 * header for the visibility-vs-ownership distinction it enforces.
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
  const items = await listRoles(execQuery, c.env, c.get('tenantId'), { usersHaveTenant: true });
  return c.json({ success: true, data: { items } });
});

app.get('/catalog', requirePermission('role:read'), (c) =>
  c.json({ success: true, data: { permissions: PERMISSIONS } }));

app.post('/', requirePermission('role:write'), async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  try {
    const created = await createRole(execQuery, c.env, c.get('tenantId'), body, PERMISSIONS);
    clearPermissionCache();
    return c.json({ success: true, data: created });
  } catch (e) {
    return fail(c, e);
  }
});

app.put('/:id', requirePermission('role:write'), async (c) => {
  const name = (await c.req.json().catch(() => ({} as any)))?.name;
  try {
    const role = await renameRole(execQuery, c.env, c.req.param('id'), c.get('tenantId'), name);
    return c.json({ success: true, data: role });
  } catch (e) {
    return fail(c, e);
  }
});

app.put('/:id/grants', requirePermission('role:write'), async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  try {
    const result = await saveGrants(execQuery, c.env, c.req.param('id'), c.get('tenantId'), body?.grants, PERMISSIONS);
    clearPermissionCache();
    return c.json({ success: true, data: result });
  } catch (e) {
    return fail(c, e);
  }
});

app.delete('/:id', requirePermission('role:write'), async (c) => {
  try {
    const result = await deleteRole(execQuery, c.env, c.req.param('id'), c.get('tenantId'));
    clearPermissionCache();
    return c.json({ success: true, data: result });
  } catch (e) {
    return fail(c, e);
  }
});

export default app;
