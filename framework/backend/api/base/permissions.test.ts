import { describe, it, expect, vi } from 'vitest';
import {
  resolvePermissions,
  createPermissions,
  createRequirePermission,
  scopeClause,
  redactRow,
  fullAccess,
  type Grant,
} from './permissions';

const CATALOG = ['order:read', 'order:write', 'invoice:read'] as const;
const grant = (permission: string, scope: 'all' | 'own' = 'all', hiddenFields: string[] = []): Grant => ({
  permission,
  scope,
  hiddenFields,
});

describe('resolvePermissions', () => {
  it('ignores granted permissions that are not in the code catalog', () => {
    const set = resolvePermissions([grant('order:read'), grant('order:approve')], null, CATALOG);
    expect(set.has('order:read')).toBe(true);
    // A row granting something no route checks must not become real access.
    expect(set.has('order:approve')).toBe(false);
  });

  it('lets an override revoke a permission the role grants', () => {
    const set = resolvePermissions([grant('order:write')], { 'order:write': false }, CATALOG);
    expect(set.has('order:write')).toBe(false);
  });

  it('lets an override narrow scope without dropping the grant', () => {
    const set = resolvePermissions([grant('order:read', 'all')], { 'order:read': 'own' }, CATALOG);
    expect(set.scopeOf('order:read')).toBe('own');
  });

  it('does not let an override grant something outside the catalog', () => {
    const set = resolvePermissions([], { 'order:approve': 'all' } as any, CATALOG);
    expect(set.has('order:approve')).toBe(false);
  });

  it('carries hidden fields through to the set', () => {
    const set = resolvePermissions([grant('order:read', 'own', ['commission'])], null, CATALOG);
    expect(set.hiddenFields('order:read')).toEqual(['commission']);
  });
});

describe('createPermissions tenant isolation', () => {
  const rowsFor = (tenant: number | null) =>
    tenant === 7 ? [{ permission: 'order:read', scope: 'all', hidden_fields: [] }] : [];

  it('never serves one tenant the cached grants of another for the same role id', async () => {
    // Same role_id, two tenants. A cache keyed on role id alone would hand
    // tenant 9 whatever tenant 7 loaded a moment earlier.
    const execQuery = vi.fn(async (_env: any, _sql: string, params: any[] = []) => {
      const [, tenantId] = params;
      return { rows: rowsFor(tenantId as number | null), rowCount: null };
    });
    const perms = createPermissions(execQuery);

    const forSeven = await perms.resolveFor({}, { role_id: 1, tenant_id: 7 }, CATALOG);
    const forNine = await perms.resolveFor({}, { role_id: 1, tenant_id: 9 }, CATALOG);

    expect(forSeven.has('order:read')).toBe(true);
    expect(forNine.has('order:read')).toBe(false);
    expect(execQuery).toHaveBeenCalledTimes(2);
  });

  it('constrains the lookup to system roles or the caller tenant', async () => {
    const execQuery = vi.fn(async () => ({ rows: [], rowCount: null }));
    const perms = createPermissions(execQuery);
    await perms.loadGrants({}, 4, 7);
    const [, sql, params] = execQuery.mock.calls[0] as any[];
    expect(sql).toMatch(/r\.tenant_id IS NULL OR r\.tenant_id = \$2/);
    expect(params).toEqual([4, 7]);
  });

  it('grants nothing when the user has no role', async () => {
    const execQuery = vi.fn(async () => ({ rows: [], rowCount: null }));
    const perms = createPermissions(execQuery);
    const set = await perms.resolveFor({}, { role_id: null }, CATALOG);
    expect(set.list()).toEqual([]);
    expect(execQuery).not.toHaveBeenCalled();
  });
});

describe('scopeClause', () => {
  const set = resolvePermissions([grant('order:read', 'own'), grant('invoice:read', 'all')], null, CATALOG);

  it('adds no predicate for all scope', () => {
    expect(scopeClause(set, 'invoice:read', 'rep_id', 'u1', 3)).toEqual({ clause: '', params: [] });
  });

  it('restricts to the owner for own scope', () => {
    expect(scopeClause(set, 'order:read', 'rep_id', 'u1', 3)).toEqual({
      clause: ' AND rep_id = $3',
      params: ['u1'],
    });
  });

  it('matches nothing when the permission is not held at all', () => {
    expect(scopeClause(set, 'order:write', 'rep_id', 'u1', 1).clause).toBe(' AND false');
  });

  it('refuses an owner column that is not a bare identifier', () => {
    expect(() => scopeClause(set, 'order:read', 'rep_id; DROP TABLE users --', 'u1', 1)).toThrow(/Unsafe owner column/);
  });
});

describe('redactRow', () => {
  it('strips the fields the caller may not see', () => {
    const set = resolvePermissions([grant('order:read', 'own', ['sold_for', 'commission'])], null, CATALOG);
    const row = { order_id: 1, ref_number: 'SO-1', sold_for: 900, commission: 90 };
    expect(redactRow(set, 'order:read', row)).toEqual({ order_id: 1, ref_number: 'SO-1' });
  });

  it('leaves the row untouched when nothing is hidden', () => {
    const set = resolvePermissions([grant('order:read')], null, CATALOG);
    const row = { order_id: 1, sold_for: 900 };
    expect(redactRow(set, 'order:read', row)).toEqual(row);
  });
});

describe('createRequirePermission', () => {
  const ctx = (user: any) => {
    const store: Record<string, any> = { user };
    return {
      req: { header: () => undefined, path: '/orders' },
      get: (k: string) => store[k],
      set: (k: string, v: any) => {
        store[k] = v;
      },
      json: (body: any, status: number) => ({ body, status }),
      store,
    };
  };

  it('401s with no authenticated user', async () => {
    const guard = createRequirePermission(async () => fullAccess(CATALOG))('order:read');
    const res: any = await guard(ctx(null) as any, async () => 'next');
    expect(res.status).toBe(401);
  });

  it('403s when the permission is not held', async () => {
    const guard = createRequirePermission(async () => resolvePermissions([], null, CATALOG))('order:read');
    const res: any = await guard(ctx({ id: 'u1' }) as any, async () => 'next');
    expect(res.status).toBe(403);
  });

  it('passes through and parks the resolved set on the context', async () => {
    const c = ctx({ id: 'u1' });
    const guard = createRequirePermission(async () => resolvePermissions([grant('order:read')], null, CATALOG))('order:read');
    const res = await guard(c as any, async () => 'next');
    expect(res).toBe('next');
    expect(c.store.permissions.has('order:read')).toBe(true);
  });

  it('resolves once and reuses the parked set', async () => {
    const c = ctx({ id: 'u1' });
    const getSet = vi.fn(async () => resolvePermissions([grant('order:read'), grant('order:write')], null, CATALOG));
    const requirePermission = createRequirePermission(getSet);
    await requirePermission('order:read')(c as any, async () => 'next');
    await requirePermission('order:write')(c as any, async () => 'next');
    expect(getSet).toHaveBeenCalledTimes(1);
  });
});
