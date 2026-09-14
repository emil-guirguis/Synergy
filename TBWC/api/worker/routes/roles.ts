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
 * Roles are rows, so creating one needs no deploy. Permissions are not: the
 * catalog is code (see ../permissions), and a grant naming anything outside it
 * is rejected here and ignored by the framework even if it reached the table —
 * otherwise the UI could invent permissions no route enforces, which look like
 * access control but aren't.
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

/** Validate and normalise submitted grants, or return the first problem. */
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

async function loadRoles(env: Env) {
  const roles = await execQuery(
    env,
    `SELECT role_id, code, name, is_system FROM public.role
      WHERE tenant_id IS NULL ORDER BY is_system DESC, name`,
    [],
    'roles.list'
  );
  const grants = await execQuery(
    env,
    `SELECT rp.role_id, rp.permission, rp.scope, rp.hidden_fields
       FROM public.role_permission rp
       JOIN public.role r ON r.role_id = rp.role_id
      WHERE r.tenant_id IS NULL
      ORDER BY rp.permission`,
    [],
    'roles.grants'
  );
  const counts = await execQuery(
    env,
    `SELECT role_id, COUNT(*)::int AS user_count FROM public.users
      WHERE role_id IS NOT NULL GROUP BY role_id`,
    [],
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
  return roles.rows.map((r: any) => ({
    ...r,
    user_count: userCounts.get(r.role_id) ?? 0,
    grants: byRole.get(r.role_id) ?? [],
  }));
}

app.get('/', requirePermission('role:read'), async (c) =>
  c.json({ success: true, data: { items: await loadRoles(c.env) } }));

app.get('/catalog', requirePermission('role:read'), (c) =>
  c.json({ success: true, data: { permissions: PERMISSIONS } }));

app.post('/', requirePermission('role:write'), async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    return c.json({ success: false, message: 'Code must be lowercase letters, digits and underscores' }, 400);
  }
  if (!name) return c.json({ success: false, message: 'Name is required' }, 400);

  const parsed = parseGrants(body.grants ?? []);
  if ('error' in parsed) return c.json({ success: false, message: parsed.error }, 400);

  const existing = await execQuery(
    c.env,
    `SELECT 1 FROM public.role WHERE tenant_id IS NULL AND code = $1`,
    [code],
    'roles.create.dupCheck'
  );
  if (existing.rows.length) return c.json({ success: false, message: `Role "${code}" already exists` }, 409);

  const created = await execQuery(
    c.env,
    `INSERT INTO public.role (code, name, is_system) VALUES ($1, $2, false) RETURNING role_id`,
    [code, name],
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

app.put('/:id', requirePermission('role:write'), async (c) => {
  const name = (await c.req.json().catch(() => ({} as any)))?.name;
  if (typeof name !== 'string' || !name.trim()) {
    return c.json({ success: false, message: 'Name is required' }, 400);
  }
  // Only the display name is editable, system role or not: `code` is what the
  // seed data and any future lookup key off.
  const r = await execQuery(
    c.env,
    `UPDATE public.role SET name = $1, updated_at = now()
      WHERE role_id = $2 AND tenant_id IS NULL RETURNING role_id, code, name, is_system`,
    [name.trim(), c.req.param('id')],
    'roles.rename'
  );
  if (!r.rows.length) return c.json({ success: false, message: 'Role not found' }, 404);
  return c.json({ success: true, data: r.rows[0] });
});

app.put('/:id/grants', requirePermission('role:write'), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({} as any));
  const parsed = parseGrants(body?.grants);
  if ('error' in parsed) return c.json({ success: false, message: parsed.error }, 400);

  const role = await execQuery(
    c.env,
    `SELECT role_id, code FROM public.role WHERE role_id = $1 AND tenant_id IS NULL`,
    [id],
    'roles.grants.find'
  );
  if (!role.rows.length) return c.json({ success: false, message: 'Role not found' }, 404);

  // Refuse to leave the instance with nobody who can edit roles: if this is the
  // last role holding role:write, removing it locks everyone out of the
  // permission model permanently, with no way back except SQL.
  const dropsRoleWrite = !parsed.grants.some((g) => g.permission === 'role:write');
  if (dropsRoleWrite) {
    const others = await execQuery(
      c.env,
      `SELECT COUNT(*)::int AS n FROM public.role_permission rp
         JOIN public.role r ON r.role_id = rp.role_id
        WHERE r.tenant_id IS NULL AND rp.permission = 'role:write' AND rp.role_id <> $1`,
      [id],
      'roles.grants.lastAdminCheck'
    );
    if ((others.rows[0]?.n ?? 0) === 0) {
      return c.json(
        { success: false, message: 'This is the only role that can manage roles — grant role:write elsewhere first.' },
        409
      );
    }
  }

  await execQuery(c.env, `DELETE FROM public.role_permission WHERE role_id = $1`, [id], 'roles.grants.clear');
  for (const g of parsed.grants) {
    await execQuery(
      c.env,
      `INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
       VALUES ($1, $2, $3, $4)`,
      [id, g.permission, g.scope, g.hidden_fields],
      'roles.grants.insert'
    );
  }
  // Grants are cached per role for a minute; drop it so an edit takes effect on
  // the next request rather than whenever the TTL happens to lapse.
  clearPermissionCache();
  return c.json({ success: true, data: { role_id: Number(id), grants: parsed.grants } });
});

app.delete('/:id', requirePermission('role:write'), async (c) => {
  const id = c.req.param('id');
  const role = await execQuery(
    c.env,
    `SELECT r.role_id, r.code, r.is_system,
            (SELECT COUNT(*)::int FROM public.users u WHERE u.role_id = r.role_id) AS user_count
       FROM public.role r WHERE r.role_id = $1 AND r.tenant_id IS NULL`,
    [id],
    'roles.delete.find'
  );
  if (!role.rows.length) return c.json({ success: false, message: 'Role not found' }, 404);
  const { is_system, user_count, code } = role.rows[0];
  if (is_system) {
    return c.json({ success: false, message: `"${code}" is a built-in role and cannot be deleted.` }, 409);
  }
  if (user_count > 0) {
    return c.json(
      { success: false, message: `${user_count} user(s) still have this role — reassign them first.` },
      409
    );
  }
  await execQuery(c.env, `DELETE FROM public.role WHERE role_id = $1`, [id], 'roles.delete');
  clearPermissionCache();
  return c.json({ success: true, data: { role_id: Number(id) } });
});

export default app;
