/**
 * Role management for Settings > Roles.
 *
 * Tenant-aware, unlike TBWC's equivalent: a role with tenant_id NULL is a
 * system role every tenant sees and nobody edits, and one carrying a tenant_id
 * belongs to that tenant alone. Every statement here filters on the caller's
 * tenant, so a role id from another tenant resolves to nothing rather than to
 * someone else's role — the id alone is never enough.
 *
 * Permissions are not user-definable: the catalog is code (see ../permissions),
 * and a grant naming anything outside it is rejected. A permission no route
 * checks would look like access control while enforcing nothing.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission, clearPermissionCache } from '../middleware';
import { PERMISSIONS } from '../permissions';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const CATALOG = new Set<string>(PERMISSIONS);
const SCOPES = new Set(['all', 'own']);

interface GrantInput {
  permission: string;
  scope?: string;
  hidden_fields?: unknown;
}

function parseGrants(raw: unknown): { grants: Required<GrantInput>[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'grants must be an array' };
  const grants: Required<GrantInput>[] = [];
  const seen = new Set<string>();
  for (const g of raw as GrantInput[]) {
    const permission = typeof g?.permission === 'string' ? g.permission : '';
    if (!CATALOG.has(permission)) return { error: `Unknown permission: ${permission || '(none)'}` };
    if (seen.has(permission)) return { error: `Duplicate permission: ${permission}` };
    seen.add(permission);
    const scope = g.scope ?? 'all';
    if (!SCOPES.has(scope)) return { error: `Unknown scope for ${permission}: ${scope}` };
    const hidden = g.hidden_fields ?? [];
    if (!Array.isArray(hidden) || hidden.some((f) => typeof f !== 'string')) {
      return { error: `hidden_fields for ${permission} must be an array of strings` };
    }
    grants.push({ permission, scope, hidden_fields: hidden as string[] });
  }
  return { grants };
}

app.get('/', requirePermission('role:read'), async (c) => {
  const tenantId = c.get('tenantId');
  const roles = await execQuery(
    c.env,
    `SELECT role_id, tenant_id, code, name, is_system FROM public.role
      WHERE tenant_id IS NULL OR tenant_id = $1
      ORDER BY is_system DESC, name`,
    [tenantId],
    'roles.list'
  );
  const grants = await execQuery(
    c.env,
    `SELECT rp.role_id, rp.permission, rp.scope, rp.hidden_fields
       FROM public.role_permission rp
       JOIN public.role r ON r.role_id = rp.role_id
      WHERE r.tenant_id IS NULL OR r.tenant_id = $1
      ORDER BY rp.permission`,
    [tenantId],
    'roles.grants'
  );
  // Counted within the tenant: a system role's user count means "mine on it",
  // not every tenant's, or one tenant would see another's headcount.
  const counts = await execQuery(
    c.env,
    `SELECT role_id, COUNT(*)::int AS user_count FROM public.users
      WHERE role_id IS NOT NULL AND tenant_id = $1 GROUP BY role_id`,
    [tenantId],
    'roles.userCounts'
  );

  const byRole = new Map<number, any[]>();
  for (const g of grants.rows) {
    if (!byRole.has(g.role_id)) byRole.set(g.role_id, []);
    byRole.get(g.role_id)!.push({
      permission: g.permission,
      scope: g.scope,
      hidden_fields: g.hidden_fields ?? [],
    });
  }
  const userCounts = new Map<number, number>(counts.rows.map((r: any) => [r.role_id, r.user_count]));
  return c.json({
    success: true,
    data: {
      items: roles.rows.map((r: any) => ({
        ...r,
        user_count: userCounts.get(r.role_id) ?? 0,
        grants: byRole.get(r.role_id) ?? [],
      })),
    },
  });
});

app.get('/catalog', requirePermission('role:read'), (c) =>
  c.json({ success: true, data: { permissions: PERMISSIONS } }));

app.post('/', requirePermission('role:write'), async (c) => {
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => ({} as any));
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    return c.json({ success: false, message: 'Code must be lowercase letters, digits and underscores' }, 400);
  }
  if (!name) return c.json({ success: false, message: 'Name is required' }, 400);

  const parsed = parseGrants(body.grants ?? []);
  if ('error' in parsed) return c.json({ success: false, message: parsed.error }, 400);

  // Clashing with a system role's code would be indistinguishable in the UI.
  const existing = await execQuery(
    c.env,
    `SELECT 1 FROM public.role WHERE code = $1 AND (tenant_id IS NULL OR tenant_id = $2)`,
    [code, tenantId],
    'roles.create.dupCheck'
  );
  if (existing.rows.length) return c.json({ success: false, message: `Role "${code}" already exists` }, 409);

  const created = await execQuery(
    c.env,
    `INSERT INTO public.role (tenant_id, code, name, is_system)
     VALUES ($1, $2, $3, false) RETURNING role_id`,
    [tenantId, code, name],
    'roles.create'
  );
  const roleId = created.rows[0].role_id;
  for (const g of parsed.grants) {
    await execQuery(
      c.env,
      `INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
       VALUES ($1, $2, $3, $4)`,
      [roleId, g.permission, g.scope, g.hidden_fields],
      'roles.create.grant'
    );
  }
  clearPermissionCache();
  return c.json({ success: true, data: { role_id: roleId } });
});

/** System roles are shared across tenants, so one tenant must not rename them. */
async function ownRole(env: Env, roleId: string, tenantId: number) {
  const r = await execQuery(
    env,
    `SELECT role_id, code, is_system, tenant_id FROM public.role
      WHERE role_id = $1 AND tenant_id = $2`,
    [roleId, tenantId],
    'roles.own'
  );
  return r.rows[0] ?? null;
}

app.put('/:id', requirePermission('role:write'), async (c) => {
  const name = (await c.req.json().catch(() => ({} as any)))?.name;
  if (typeof name !== 'string' || !name.trim()) {
    return c.json({ success: false, message: 'Name is required' }, 400);
  }
  const role = await ownRole(c.env, c.req.param('id'), c.get('tenantId'));
  if (!role) return c.json({ success: false, message: 'Role not found' }, 404);

  const r = await execQuery(
    c.env,
    `UPDATE public.role SET name = $1, updated_at = now() WHERE role_id = $2
     RETURNING role_id, code, name, is_system`,
    [name.trim(), role.role_id],
    'roles.rename'
  );
  return c.json({ success: true, data: r.rows[0] });
});

app.put('/:id/grants', requirePermission('role:write'), async (c) => {
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => ({} as any));
  const parsed = parseGrants(body?.grants);
  if ('error' in parsed) return c.json({ success: false, message: parsed.error }, 400);

  const role = await ownRole(c.env, c.req.param('id'), tenantId);
  if (!role) return c.json({ success: false, message: 'Role not found' }, 404);

  // Don't let a tenant strip role:write from its last role that has it — there
  // would be no way back without SQL. Scoped to this tenant's own roles plus
  // the system ones they inherit.
  if (!parsed.grants.some((g) => g.permission === 'role:write')) {
    const others = await execQuery(
      c.env,
      `SELECT COUNT(*)::int AS n FROM public.role_permission rp
         JOIN public.role r ON r.role_id = rp.role_id
        WHERE (r.tenant_id IS NULL OR r.tenant_id = $1)
          AND rp.permission = 'role:write' AND rp.role_id <> $2`,
      [tenantId, role.role_id],
      'roles.grants.lastAdminCheck'
    );
    if ((others.rows[0]?.n ?? 0) === 0) {
      return c.json(
        { success: false, message: 'This is the only role that can manage roles — grant role:write elsewhere first.' },
        409
      );
    }
  }

  await execQuery(c.env, `DELETE FROM public.role_permission WHERE role_id = $1`, [role.role_id], 'roles.grants.clear');
  for (const g of parsed.grants) {
    await execQuery(
      c.env,
      `INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
       VALUES ($1, $2, $3, $4)`,
      [role.role_id, g.permission, g.scope, g.hidden_fields],
      'roles.grants.insert'
    );
  }
  clearPermissionCache();
  return c.json({ success: true, data: { role_id: role.role_id, grants: parsed.grants } });
});

app.delete('/:id', requirePermission('role:write'), async (c) => {
  const tenantId = c.get('tenantId');
  const role = await ownRole(c.env, c.req.param('id'), tenantId);
  if (!role) return c.json({ success: false, message: 'Role not found' }, 404);
  if (role.is_system) {
    return c.json({ success: false, message: `"${role.code}" is a built-in role and cannot be deleted.` }, 409);
  }
  const inUse = await execQuery(
    c.env,
    `SELECT COUNT(*)::int AS n FROM public.users WHERE role_id = $1`,
    [role.role_id],
    'roles.delete.inUse'
  );
  const n = inUse.rows[0]?.n ?? 0;
  if (n > 0) {
    return c.json({ success: false, message: `${n} user(s) still have this role — reassign them first.` }, 409);
  }
  await execQuery(c.env, `DELETE FROM public.role WHERE role_id = $1`, [role.role_id], 'roles.delete');
  clearPermissionCache();
  return c.json({ success: true, data: { role_id: role.role_id } });
});

export default app;
