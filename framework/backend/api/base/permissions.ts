/**
 * Role-based permissions — the shared policy model both apps enforce against.
 * `auth.ts` covers the mechanics (who is calling); this covers what they may do.
 *
 * A permission is a `module:action` string. A role holds a set of grants, each
 * carrying a scope (`all` = every row, `own` = only rows the caller owns) and an
 * optional list of fields to strip from responses. Users point at one role and
 * may carry per-user overrides on top.
 *
 * The catalog of valid permission strings lives in each app's code, because a
 * permission only means anything if a route actually checks it. Grants are
 * rows, so new roles are data — no deploy. Anything the DB grants that isn't in
 * the catalog is ignored rather than honoured, so a stale or hand-inserted row
 * can never widen access beyond what the code enforces.
 *
 * Nothing here branches on a role's name. Roles are user-creatable, so a check
 * against a specific role would silently exclude every role created later.
 */
import type { ExecQueryFn } from './crud';
import { createEntityCache } from './auth';

export type Scope = 'all' | 'own';

export interface Grant {
  permission: string;
  scope: Scope;
  /** Fields stripped from responses for this module. See redactRow(). */
  hiddenFields: string[];
}

/**
 * Per-user adjustments layered over the role, stored as jsonb on the user row:
 * `{"order:write": "own"}` narrows or grants, `{"order:write": false}` revokes.
 * Meant to stay rare — the role is the unit people manage.
 */
export type PermissionOverrides = Record<string, Scope | false> | null | undefined;

export interface PermissionSet {
  has(permission: string): boolean;
  /** The granted scope, or null when the permission isn't held at all. */
  scopeOf(permission: string): Scope | null;
  hiddenFields(permission: string): string[];
  /** Everything held, for shipping to the frontend via /auth/me. */
  list(): Grant[];
}

const DENY_ALL: PermissionSet = {
  has: () => false,
  scopeOf: () => null,
  hiddenFields: () => [],
  list: () => [],
};

/** A set that holds every catalogued permission at `all` scope, for the
 *  super-admin style flags each app keeps outside the role model. */
export function fullAccess(catalog: readonly string[]): PermissionSet {
  return {
    has: (p) => catalog.includes(p),
    scopeOf: (p) => (catalog.includes(p) ? 'all' : null),
    hiddenFields: () => [],
    list: () => catalog.map((permission) => ({ permission, scope: 'all' as Scope, hiddenFields: [] })),
  };
}

export function resolvePermissions(
  grants: Grant[],
  overrides: PermissionOverrides,
  catalog: readonly string[]
): PermissionSet {
  const known = new Set(catalog);
  const held = new Map<string, Grant>();

  for (const g of grants) {
    if (!known.has(g.permission)) continue;
    held.set(g.permission, g);
  }

  for (const [permission, value] of Object.entries(overrides ?? {})) {
    if (!known.has(permission)) continue;
    if (value === false) {
      held.delete(permission);
    } else if (value === 'all' || value === 'own') {
      held.set(permission, { ...held.get(permission), permission, scope: value, hiddenFields: held.get(permission)?.hiddenFields ?? [] });
    }
  }

  return {
    has: (p) => held.has(p),
    scopeOf: (p) => held.get(p)?.scope ?? null,
    hiddenFields: (p) => held.get(p)?.hiddenFields ?? [],
    list: () => [...held.values()],
  };
}

const GRANT_TTL_MS = 60_000;

export function createPermissions(execQuery: ExecQueryFn, ttlMs = GRANT_TTL_MS) {
  const grantCache = createEntityCache<Grant[]>(ttlMs);

  /**
   * Grants for one role. `tenantId` is not a filter for convenience — it is the
   * isolation boundary: a role with a tenant_id belongs to that tenant alone,
   * and only a system role (tenant_id IS NULL) is visible to everyone. A caller
   * whose tenant doesn't match gets zero grants rather than an error, so a
   * mismatched or absent tenant fails closed instead of inheriting someone
   * else's role. The cache key carries the tenant for the same reason — keying
   * on role id alone would let one tenant's resolved grants be served to
   * another on a cache hit.
   */
  async function loadGrants(env: any, roleId: number | string | null, tenantId?: number | null): Promise<Grant[]> {
    if (roleId === null || roleId === undefined) return [];
    return (
      (await grantCache.get(`${tenantId ?? 'system'}:${roleId}`, async () => {
        const r = await execQuery(
          env,
          `SELECT rp.permission, rp.scope, COALESCE(rp.hidden_fields, '{}') AS hidden_fields
             FROM public.role r
             JOIN public.role_permission rp ON rp.role_id = r.role_id
            WHERE r.role_id = $1
              AND (r.tenant_id IS NULL OR r.tenant_id = $2)`,
          [roleId, tenantId ?? null],
          'permissions.loadGrants'
        );
        return r.rows.map((row: any) => ({
          permission: row.permission,
          scope: row.scope === 'own' ? 'own' : 'all',
          hiddenFields: Array.isArray(row.hidden_fields) ? row.hidden_fields : [],
        }));
      })) ?? []
    );
  }

  async function resolveFor(
    env: any,
    user: { role_id?: number | string | null; permission_overrides?: PermissionOverrides; tenant_id?: number | null },
    catalog: readonly string[]
  ): Promise<PermissionSet> {
    if (!user) return DENY_ALL;
    const grants = await loadGrants(env, user.role_id ?? null, user.tenant_id ?? null);
    return resolvePermissions(grants, user.permission_overrides, catalog);
  }

  return { loadGrants, resolveFor, clearCache: () => grantCache.clear() };
}

// ===== Enforcement =====
// Duck-typed for the same reason auth.ts is: each app installs its own `hono`,
// so importing Context here fails to satisfy the apps' middleware types.
interface MinimalContext {
  req: { header(name: string): string | undefined; path: string };
  get(key: string): any;
  set(key: string, value: any): void;
  json(body: any, status: number): any;
}
type NextFn = () => Promise<any>;

/**
 * Builds the app's `requirePermission('order:read')` guard. `getSet` resolves
 * the caller's PermissionSet however that app loads its user; the resolved set
 * is parked on the context as `permissions` so handlers can read scope and
 * hidden fields without resolving again.
 */
export function createRequirePermission(getSet: (c: MinimalContext) => Promise<PermissionSet | null>) {
  return (permission: string) =>
    async (c: MinimalContext, next: NextFn) => {
      if (!c.get('user')) return c.json({ success: false, message: 'Authentication required' }, 401);
      let set = c.get('permissions') as PermissionSet | undefined;
      if (!set) {
        set = (await getSet(c)) ?? DENY_ALL;
        c.set('permissions', set);
      }
      if (!set.has(permission)) {
        return c.json({ success: false, message: 'Insufficient permissions' }, 403);
      }
      return next();
    };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * SQL fragment restricting a query to what this caller may see: empty for `all`
 * scope, an owner-column predicate for `own`. `$${paramIndex}` is the next free
 * placeholder in the caller's params array.
 *
 * `ownerColumn` is interpolated, so it must be a column name the code chose —
 * never a request value. Rejected outright if it isn't a bare identifier.
 */
export function scopeClause(
  set: PermissionSet,
  permission: string,
  ownerColumn: string,
  ownerValue: unknown,
  paramIndex: number
): { clause: string; params: unknown[] } {
  if (!IDENTIFIER.test(ownerColumn)) throw new Error(`Unsafe owner column: ${ownerColumn}`);
  const scope = set.scopeOf(permission);
  // No grant at all shouldn't reach a query — requirePermission has already
  // 403'd — but if it does, scope to nothing rather than to everything.
  if (scope === null) return { clause: ` AND false`, params: [] };
  if (scope === 'all') return { clause: '', params: [] };
  return { clause: ` AND ${ownerColumn} = $${paramIndex}`, params: [ownerValue] };
}

/** Strip the fields this caller may not see from an outgoing row. */
export function redactRow<T extends Record<string, any>>(set: PermissionSet, permission: string, row: T): T {
  const hidden = set.hiddenFields(permission);
  if (!hidden.length || !row) return row;
  const out = { ...row };
  for (const f of hidden) delete out[f];
  return out;
}

export function redactRows<T extends Record<string, any>>(set: PermissionSet, permission: string, rows: T[]): T[] {
  const hidden = set.hiddenFields(permission);
  if (!hidden.length) return rows;
  return rows.map((r) => redactRow(set, permission, r));
}
