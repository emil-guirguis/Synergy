import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentPermSet = new Set(['repPerformance:read']);
let currentScope: 'all' | 'own' = 'all';
let currentUser: any = { id: 'admin' };

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', currentUser);
    c.set('userId', currentUser.id);
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) => {
    if (!currentPermSet.has(permission)) {
      return c.json({ success: false, message: 'Insufficient permissions' }, 403);
    }
    c.set('permissions', { scopeOf: () => currentScope });
    return next();
  },
  // Real implementations — the rule under test is "own rep + managed reps".
  visibleRepListIds: (user: any) =>
    [user.sales_rep_list_id, ...(user.managed_sales_rep_list_ids ?? [])].filter(Boolean),
  reportRepScope: (c: any, permission: string) =>
    c.get('permissions')?.scopeOf(permission) === 'own'
      ? [c.get('user').sales_rep_list_id, ...(c.get('user').managed_sales_rep_list_ids ?? [])].filter(Boolean)
      : null,
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import repPerformanceApp from './repPerformance';

const ENV = {} as any;
const req = (path: string) => repPerformanceApp.request(path, undefined, ENV);

/** Every (sql, params) pair execQuery was called with, keyed by its label. */
function callsByLabel(): Record<string, { sql: string; params: any[] }> {
  const out: Record<string, { sql: string; params: any[] }> = {};
  for (const [, sql, params, label] of mockExecQuery.mock.calls) {
    out[label] = { sql, params };
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentPermSet = new Set(['repPerformance:read']);
  currentScope = 'all';
  currentUser = { id: 'admin' };
  mockExecQuery.mockResolvedValue({ rows: [] });
});

describe('permission gate', () => {
  it('403s without repPerformance:read', async () => {
    currentPermSet = new Set();
    const res = await req('/summary');
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('all scope', () => {
  it('passes a null scope, so the guard in each query filters nothing', async () => {
    const res = await req('/summary?year=2026');
    expect(res.status).toBe(200);
    const calls = callsByLabel();
    expect(calls['repPerformance.booked'].params).toEqual([2026, null]);
    expect(calls['repPerformance.reps'].params).toEqual([null]);
  });
});

describe('own scope', () => {
  it('restricts every aggregate to the caller rep + managed reps', async () => {
    currentScope = 'own';
    currentUser = { id: 'rep', sales_rep_list_id: 'REP1', managed_sales_rep_list_ids: ['REP2'] };
    const res = await req('/summary?year=2026');
    expect(res.status).toBe(200);
    const calls = callsByLabel();
    // All seven queries, not just the rep list driving the merge.
    expect(Object.keys(calls)).toHaveLength(7);
    for (const [label, { params }] of Object.entries(calls)) {
      expect(params, label).toContainEqual(['REP1', 'REP2']);
    }
    expect(calls['repPerformance.reps'].sql).toContain('list_id = ANY($1::text[])');
    expect(calls['repPerformance.reps'].params).toEqual([['REP1', 'REP2']]);
    expect(calls['repPerformance.booked'].sql).toContain('sales_rep_list_id = ANY($2::text[])');
    expect(calls['repPerformance.booked'].params).toEqual([2026, ['REP1', 'REP2']]);
    expect(calls['repPerformance.collected'].sql).toContain('i.sales_rep_list_id = ANY($2::text[])');
    expect(calls['repPerformance.years'].sql).toContain('sales_rep_list_id = ANY($1::text[])');
  });

  it('sends an empty rep array — matching nothing — when the caller has no rep and manages nobody', async () => {
    currentScope = 'own';
    currentUser = { id: 'rep' };
    const res = await req('/summary?year=2026');
    expect(res.status).toBe(200);
    for (const [, { params }] of Object.entries(callsByLabel())) {
      expect(params).toContainEqual([]);
    }
    expect((await res.json() as any).data.items).toEqual([]);
  });

  it('reports only the scoped rep rows', async () => {
    currentScope = 'own';
    currentUser = { id: 'rep', sales_rep_list_id: 'REP1' };
    mockExecQuery.mockImplementation((_env: any, _sql: string, _params: any[], label: string) => {
      if (label === 'repPerformance.reps') return { rows: [{ list_id: 'REP1', name: 'Own Rep' }] };
      if (label === 'repPerformance.commission') {
        return { rows: [{ list_id: 'REP1', commission_paid: '250.50', paid_order_count: 2 }] };
      }
      if (label === 'repPerformance.years') return { rows: [{ y: 2026 }] };
      return { rows: [] };
    });
    const res = await req('/summary?year=2026');
    const body: any = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      list_id: 'REP1',
      name: 'Own Rep',
      commissionPaid: 250.5,
      paidOrderCount: 2,
    });
  });
});
