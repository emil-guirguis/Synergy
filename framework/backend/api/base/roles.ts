/**
 * Shared role/permission management — the framework-owned half of Settings >
 * Roles. Each app wraps these plain functions in its own thin Hono route with
 * its own auth middleware (see TBWC/api/worker/routes/roles.ts and
 * MeterItPro/api/worker/routes/roles.ts). Table DDL:
 * framework/backend/db/role.sql (copied into each app's migrations —
 * TBWC/api/migrations/039, MeterItPro/api/migrations/053).
 *
 * Deliberately not importing Hono (same duplicate-package hazard as auth.ts
 * and documents.ts): these are plain functions taking execQuery + env.
 *
 * Single-tenant vs multi-tenant, in one shape:
 * `tenant_id` on a role is NULL for a system role (visible to everyone) or set
 * for a role private to one tenant. TBWC has no tenant concept and always
 * passes `tenantId: null` — every role it creates lands with tenant_id NULL,
 * so it behaves as if every role were a system role. MeterItPro passes its
 * real tenant id, so its tenant-created roles are invisible to and
 * unrenamable by every other tenant.
 *
 * Two different clauses matter, and mixing them up reopens a cross-tenant hole:
 *  - VISIBILITY (list, dup-check, last-admin-check): `tenant_id IS NULL OR
 *    tenant_id = $tenantId` — see everything you're allowed to see.
 *  - OWNERSHIP (rename, edit grants, delete): a tenant may only ever mutate
 *    its own roles, never a system role — except when there is no tenant
 *    concept at all (tenantId is null), in which case "its own roles" is
 *    every role, matching TBWC's existing behaviour of allowing system-role
 *    renames. Expressed as `tenant_id = $tenantId OR ($tenantId IS NULL AND
 *    tenant_id IS NULL)`.
 */
import type { ExecQueryFn } from './crud';

export type GrantScope = 'all' | 'own';

export interface FieldAccessInput {
  view?: boolean;
  edit?: boolean;
}

export interface RoleGrantInput {
  permission: string;
  scope?: string;
  hidden_fields?: unknown;
  field_access?: unknown;
}

export interface ParsedGrant {
  permission: string;
  scope: GrantScope;
  hidden_fields: string[];
  field_access: Record<string, FieldAccessInput>;
}

export interface RoleRow {
  role_id: number;
  tenant_id: number | null;
  code: string;
  name: string;
  is_system: boolean;
  user_count: number;
  grants: ParsedGrant[];
}

/** Thrown for bad client input; app routes map this to a 400. */
export class RoleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleValidationError';
  }
}

/** Thrown for a legal-but-blocked request; app routes map this to a 409. */
export class RoleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleConflictError';
  }
}

/** Thrown when a role id doesn't resolve (wrong id, or belongs to another tenant); app routes map this to a 404. */
export class RoleNotFoundError extends Error {
  constructor() {
    super('Role not found');
    this.name = 'RoleNotFoundError';
  }
}

const SCOPES = new Set<GrantScope>(['all', 'own']);
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Validate one grant's field_access map: {field: {view?, edit?}}, booleans only. */
function parseFieldAccess(raw: unknown, permission: string): Record<string, FieldAccessInput> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RoleValidationError(`field_access for ${permission} must be an object`);
  }
  const out: Record<string, FieldAccessInput> = {};
  for (const [field, access] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof access !== 'object' || access === null || Array.isArray(access)) {
      throw new RoleValidationError(`field_access.${field} for ${permission} must be an object`);
    }
    const { view, edit, ...rest } = access as Record<string, unknown>;
    if (
      Object.keys(rest).length ||
      (view !== undefined && typeof view !== 'boolean') ||
      (edit !== undefined && typeof edit !== 'boolean')
    ) {
      throw new RoleValidationError(`field_access.${field} for ${permission} must be {view?: boolean, edit?: boolean}`);
    }
    const entry: FieldAccessInput = {};
    if (typeof view === 'boolean') entry.view = view;
    if (typeof edit === 'boolean') entry.edit = edit;
    out[field] = entry;
  }
  return out;
}

/** Validate and normalise submitted grants against the app's own permission catalog. */
export function parseGrants(raw: unknown, catalog: readonly string[]): ParsedGrant[] {
  if (!Array.isArray(raw)) throw new RoleValidationError('grants must be an array');
  const known = new Set(catalog);
  const grants: ParsedGrant[] = [];
  const seen = new Set<string>();
  for (const g of raw as RoleGrantInput[]) {
    const permission = typeof g?.permission === 'string' ? g.permission : '';
    if (!known.has(permission)) throw new RoleValidationError(`Unknown permission: ${permission || '(none)'}`);
    if (seen.has(permission)) throw new RoleValidationError(`Duplicate permission: ${permission}`);
    seen.add(permission);
    const scope = (g.scope ?? 'all') as GrantScope;
    if (!SCOPES.has(scope)) throw new RoleValidationError(`Unknown scope for ${permission}: ${scope}`);
    const hidden = g.hidden_fields ?? [];
    if (!Array.isArray(hidden) || hidden.some((f) => typeof f !== 'string')) {
      throw new RoleValidationError(`hidden_fields for ${permission} must be an array of strings`);
    }
    const fieldAccess = parseFieldAccess(g.field_access, permission);
    grants.push({ permission, scope, hidden_fields: hidden as string[], field_access: fieldAccess });
  }
  return grants;
}

export interface RolesOptions {
  /**
   * Pass true only when `public.users` itself has a `tenant_id` column
   * (MeterItPro). TBWC's `users` table has no such column — referencing it
   * would fail to prepare regardless of parameter values — so its user counts
   * are simply global per role_id, same as before this module existed.
   */
  usersHaveTenant?: boolean;
}

/** Every role this tenant may see (system roles plus its own), with grants and user counts. */
export async function listRoles(
  execQuery: ExecQueryFn,
  env: any,
  tenantId: number | null,
  options?: RolesOptions
): Promise<RoleRow[]> {
  const roles = await execQuery(
    env,
    `SELECT role_id, tenant_id, code, name, is_system FROM public.role
      WHERE tenant_id IS NULL OR tenant_id = $1
      ORDER BY is_system DESC, name`,
    [tenantId],
    'roles.list'
  );
  const grants = await execQuery(
    env,
    `SELECT rp.role_id, rp.permission, rp.scope, rp.hidden_fields,
            COALESCE(rp.field_access, '{}'::jsonb) AS field_access
       FROM public.role_permission rp
       JOIN public.role r ON r.role_id = rp.role_id
      WHERE r.tenant_id IS NULL OR r.tenant_id = $1
      ORDER BY rp.permission`,
    [tenantId],
    'roles.grants'
  );
  // Counted within the tenant: a system role's user count means "mine on it",
  // not every tenant's, or one tenant would see another's headcount. Only
  // meaningful where users.tenant_id exists at all (see RolesOptions).
  const counts = options?.usersHaveTenant
    ? await execQuery(
        env,
        `SELECT role_id, COUNT(*)::int AS user_count FROM public.users
          WHERE role_id IS NOT NULL AND tenant_id = $1
          GROUP BY role_id`,
        [tenantId],
        'roles.userCounts'
      )
    : await execQuery(
        env,
        `SELECT role_id, COUNT(*)::int AS user_count FROM public.users
          WHERE role_id IS NOT NULL
          GROUP BY role_id`,
        [],
        'roles.userCounts'
      );

  const byRole = new Map<number, ParsedGrant[]>();
  for (const g of grants.rows) {
    if (!byRole.has(g.role_id)) byRole.set(g.role_id, []);
    byRole.get(g.role_id)!.push({
      permission: g.permission,
      scope: g.scope === 'own' ? 'own' : 'all',
      hidden_fields: g.hidden_fields ?? [],
      field_access: g.field_access && typeof g.field_access === 'object' ? g.field_access : {},
    });
  }
  const userCounts = new Map<number, number>(counts.rows.map((r: any) => [r.role_id, r.user_count]));
  return roles.rows.map((r: any) => ({
    ...r,
    user_count: userCounts.get(r.role_id) ?? 0,
    grants: byRole.get(r.role_id) ?? [],
  }));
}

export async function createRole(
  execQuery: ExecQueryFn,
  env: any,
  tenantId: number | null,
  input: { code: unknown; name: unknown; grants: unknown },
  catalog: readonly string[]
): Promise<{ role_id: number }> {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!CODE_PATTERN.test(code)) {
    throw new RoleValidationError('Code must be lowercase letters, digits and underscores');
  }
  if (!name) throw new RoleValidationError('Name is required');
  const grants = parseGrants(input.grants ?? [], catalog);

  // Clashing with a system role's (or the tenant's own) code would be
  // indistinguishable in the UI.
  const existing = await execQuery(
    env,
    `SELECT 1 FROM public.role WHERE code = $1 AND (tenant_id IS NULL OR tenant_id = $2)`,
    [code, tenantId],
    'roles.create.dupCheck'
  );
  if (existing.rows.length) throw new RoleConflictError(`Role "${code}" already exists`);

  const created = await execQuery(
    env,
    `INSERT INTO public.role (tenant_id, code, name, is_system) VALUES ($1, $2, $3, false) RETURNING role_id`,
    [tenantId, code, name],
    'roles.create'
  );
  const roleId = created.rows[0].role_id;
  for (const g of grants) {
    await execQuery(
      env,
      `INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields, field_access) VALUES ($1, $2, $3, $4, $5)`,
      [roleId, g.permission, g.scope, g.hidden_fields, JSON.stringify(g.field_access)],
      'roles.create.grant'
    );
  }
  return { role_id: roleId };
}

/**
 * The role this tenant may mutate: its own, or (when there's no tenant
 * concept, i.e. tenantId is null) any role at all — see the ownership-clause
 * note in the file header. Null if the id doesn't resolve to one.
 */
export async function ownRole(
  execQuery: ExecQueryFn,
  env: any,
  roleId: string | number,
  tenantId: number | null
): Promise<{ role_id: number; code: string; name: string; is_system: boolean; tenant_id: number | null } | null> {
  const r = await execQuery(
    env,
    `SELECT role_id, code, name, is_system, tenant_id FROM public.role
      WHERE role_id = $1 AND (tenant_id = $2 OR ($2 IS NULL AND tenant_id IS NULL))`,
    [roleId, tenantId],
    'roles.own'
  );
  return r.rows[0] ?? null;
}

export async function renameRole(
  execQuery: ExecQueryFn,
  env: any,
  roleId: string | number,
  tenantId: number | null,
  name: unknown
): Promise<{ role_id: number; code: string; name: string; is_system: boolean }> {
  if (typeof name !== 'string' || !name.trim()) throw new RoleValidationError('Name is required');
  const role = await ownRole(execQuery, env, roleId, tenantId);
  if (!role) throw new RoleNotFoundError();
  const r = await execQuery(
    env,
    `UPDATE public.role SET name = $1, updated_at = now() WHERE role_id = $2
     RETURNING role_id, code, name, is_system`,
    [name.trim(), role.role_id],
    'roles.rename'
  );
  return r.rows[0];
}

export async function saveGrants(
  execQuery: ExecQueryFn,
  env: any,
  roleId: string | number,
  tenantId: number | null,
  rawGrants: unknown,
  catalog: readonly string[]
): Promise<{ role_id: number; grants: ParsedGrant[] }> {
  const grants = parseGrants(rawGrants, catalog);
  const role = await ownRole(execQuery, env, roleId, tenantId);
  if (!role) throw new RoleNotFoundError();

  // Refuse to leave the instance with nobody who can edit roles: if this is
  // the last role holding role:write (among the ones this tenant can see),
  // removing it locks everyone out of the permission model with no way back
  // except SQL.
  const dropsRoleWrite = !grants.some((g) => g.permission === 'role:write');
  if (dropsRoleWrite) {
    const others = await execQuery(
      env,
      `SELECT COUNT(*)::int AS n FROM public.role_permission rp
         JOIN public.role r ON r.role_id = rp.role_id
        WHERE (r.tenant_id IS NULL OR r.tenant_id = $1)
          AND rp.permission = 'role:write' AND rp.role_id <> $2`,
      [tenantId, role.role_id],
      'roles.grants.lastAdminCheck'
    );
    if ((others.rows[0]?.n ?? 0) === 0) {
      throw new RoleConflictError('This is the only role that can manage roles — grant role:write elsewhere first.');
    }
  }

  await execQuery(env, `DELETE FROM public.role_permission WHERE role_id = $1`, [role.role_id], 'roles.grants.clear');
  for (const g of grants) {
    await execQuery(
      env,
      `INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields, field_access) VALUES ($1, $2, $3, $4, $5)`,
      [role.role_id, g.permission, g.scope, g.hidden_fields, JSON.stringify(g.field_access)],
      'roles.grants.insert'
    );
  }
  return { role_id: role.role_id, grants };
}

export async function deleteRole(
  execQuery: ExecQueryFn,
  env: any,
  roleId: string | number,
  tenantId: number | null
): Promise<{ role_id: number }> {
  const role = await ownRole(execQuery, env, roleId, tenantId);
  if (!role) throw new RoleNotFoundError();
  if (role.is_system) {
    throw new RoleConflictError(`"${role.code}" is a built-in role and cannot be deleted.`);
  }
  const inUse = await execQuery(
    env,
    `SELECT COUNT(*)::int AS n FROM public.users WHERE role_id = $1`,
    [role.role_id],
    'roles.delete.inUse'
  );
  const n = inUse.rows[0]?.n ?? 0;
  if (n > 0) {
    throw new RoleConflictError(`${n} user(s) still have this role — reassign them first.`);
  }
  await execQuery(env, `DELETE FROM public.role WHERE role_id = $1`, [role.role_id], 'roles.delete');
  return { role_id: role.role_id };
}
