/**
 * Cross-report audit: every Reports endpoint must take its row scope the same
 * way — middleware's reportRepScope passed as a SQL parameter, guarded with
 * `($n::text[] IS NULL OR <rep column> = ANY($n::text[]))`. One `own` grant
 * then narrows every figure on the page, and no report can quietly compute a
 * company-wide number for a rep-scoped role.
 *
 * Asserted per query rather than per route on purpose: the Rep Performance bug
 * this file guards against was one unscoped aggregate among several scoped
 * ones, which a response-shape test would have missed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const REPS = ['REP1', 'REP2'];
let currentScope: 'all' | 'own' = 'all';

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', { id: 'u', sales_rep_list_id: 'REP1', managed_sales_rep_list_ids: ['REP2'] });
    c.set('userId', 'u');
    return next();
  },
  requirePermission: () => (c: any, next: any) => {
    c.set('permissions', { scopeOf: () => currentScope, has: () => true });
    return next();
  },
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
import orderToCashApp from './orderToCash';
import invoiceTotalsApp from './invoiceTotals';
import revenueByRegionApp from './revenueByRegion';
import arAgingApp from './arAging';

const ENV = {} as any;

/** Every Reports endpoint, by the nav label it backs. */
const ENDPOINTS: { name: string; app: { request: Function }; path: string }[] = [
  { name: 'Rep Performance', app: repPerformanceApp, path: '/summary?year=2026' },
  { name: 'Order-to-Cash', app: orderToCashApp, path: '/summary?year=2026' },
  { name: 'Invoice Totals (cards)', app: invoiceTotalsApp, path: '/summary?period=month' },
  { name: 'Invoice Totals (trend)', app: invoiceTotalsApp, path: '/timeseries?period=month' },
  { name: 'Invoice Totals (custom trend)', app: invoiceTotalsApp, path: '/timeseries?period=custom' },
  { name: 'Revenue by Region', app: revenueByRegionApp, path: '/summary?year=2026' },
  { name: 'AR Aging', app: arAgingApp, path: '/summary' },
];

/** The scope parameter's 1-based placeholder, read off the guard in the SQL. */
function scopePlaceholder(sql: string): number | null {
  const m = sql.match(/\$(\d+)::text\[\] IS NULL OR/);
  return m ? Number(m[1]) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecQuery.mockResolvedValue({ rows: [] });
});

describe.each(ENDPOINTS)('$name', ({ app, path }) => {
  it('guards every query with the scope parameter', async () => {
    currentScope = 'own';
    const res = await app.request(path, undefined, ENV);
    expect(res.status).toBe(200);
    expect(mockExecQuery.mock.calls.length).toBeGreaterThan(0);
    for (const [, sql, params, label] of mockExecQuery.mock.calls) {
      const n = scopePlaceholder(sql);
      expect(n, `${label}: no ($n::text[] IS NULL OR ...) scope guard`).not.toBeNull();
      expect(sql, label).toContain(`= ANY($${n}::text[])`);
      expect(params[n! - 1], `${label}: $${n} is not the rep scope`).toEqual(REPS);
    }
  });

  it('passes null in that same slot at all scope, so nothing is filtered', async () => {
    currentScope = 'all';
    const res = await app.request(path, undefined, ENV);
    expect(res.status).toBe(200);
    for (const [, sql, params, label] of mockExecQuery.mock.calls) {
      const n = scopePlaceholder(sql);
      expect(n, `${label}: no scope guard`).not.toBeNull();
      expect(params[n! - 1], `${label}: $${n} should be null at all scope`).toBeNull();
    }
  });
});

describe('Invoice Totals rep filter', () => {
  it('cannot widen the scope — ?repId is ANDed with it, not substituted for it', async () => {
    currentScope = 'own';
    const res = await invoiceTotalsApp.request('/summary?period=month&repId=SOMEONE_ELSE', undefined, ENV);
    expect(res.status).toBe(200);
    const [, sql, params] = mockExecQuery.mock.calls.find(([, , , label]) => label === 'invoiceTotals.summary')!;
    expect(sql).toContain('sales_rep_list_id = $7');
    expect(sql).toContain('sales_rep_list_id = ANY($8::text[])');
    expect(params[6]).toBe('SOMEONE_ELSE');
    expect(params[7]).toEqual(REPS);
  });

  it('offers only in-scope reps in the dropdown', async () => {
    currentScope = 'own';
    await invoiceTotalsApp.request('/summary?period=month', undefined, ENV);
    const [, sql, params] = mockExecQuery.mock.calls.find(([, , , label]) => label === 'invoiceTotals.reps')!;
    expect(sql).toContain('list_id = ANY($1::text[])');
    expect(params).toEqual([REPS]);
  });
});
