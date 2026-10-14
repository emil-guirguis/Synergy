import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePermissions, fullAccess } from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from '../permissions';

let currentUser: any = { id: 'admin', sales_rep_list_id: null };
let currentPermSet = fullAccess(PERMISSIONS);

vi.mock('../middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware')>();
  return {
    ...actual,
    authenticateToken: (c: any, next: any) => {
      c.set('user', currentUser);
      c.set('userId', currentUser.id);
      return next();
    },
    requirePermission: (permission: string) => (c: any, next: any) => {
      if (!currentPermSet.has(permission)) {
        return c.json({ success: false, message: 'Insufficient permissions' }, 403);
      }
      c.set('permissions', currentPermSet);
      return next();
    },
  };
});

const mockFindAll = vi.fn();
const mockFindById = vi.fn();
vi.mock('../crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crud')>();
  return {
    ...actual,
    findAll: (...a: any[]) => mockFindAll(...a),
    findById: (...a: any[]) => mockFindById(...a),
  };
});

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
  // Tests don't exercise transactional behavior (no POST/PUT coverage below) —
  // just run fn against the same mocked query fn so quotes.ts's import resolves.
  withTransaction: (_env: any, fn: any) => fn((...a: any[]) => mockExecQuery(...a)),
}));

import quotesApp from './quotes';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => quotesApp.request(path, init, ENV);

function repPermSet() {
  return resolvePermissions([{ permission: 'quote:read', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin', sales_rep_list_id: null };
  currentPermSet = fullAccess(PERMISSIONS);
  // GET /:id always fetches quote_line rows via execQuery after findById.
  mockExecQuery.mockResolvedValue({ rows: [] });
});

describe('permission gate', () => {
  it('403s GET / without quote:read', async () => {
    currentPermSet = resolvePermissions([], null, PERMISSIONS);
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockFindAll).not.toHaveBeenCalled();
  });
});

describe('GET / scoping', () => {
  it('admin (all scope) sees every quote, no rep filter', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toEqual([]);
  });

  it('a rep (own scope) is filtered to their linked sales_rep_list_id', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].whereRaw).toEqual([
      { sql: 'sales_rep_list_id IN (?)', params: ['REP-123'] },
    ]);
  });

  it('a rep who manages others is scoped to their own rep plus every managed rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123', managed_sales_rep_list_ids: ['REP-456', 'REP-789'] };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].whereRaw).toEqual([
      { sql: 'sales_rep_list_id IN (?, ?, ?)', params: ['REP-123', 'REP-456', 'REP-789'] },
    ]);
  });

  it('an unlinked rep (manages nobody) gets a filter that can never match a real quote', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].whereRaw).toEqual([{ sql: '1 = 0' }]);
  });
});

describe('GET /:id scoping', () => {
  it("404s (not 403) when a rep requests another rep's quote", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ quote_id: 1, sales_rep_list_id: 'OTHER-REP' });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it("a managing rep can see a managed user's quote", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123', managed_sales_rep_list_ids: ['REP-456'] };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ quote_id: 1, sales_rep_list_id: 'REP-456' });
    const res = await req('/1');
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:id', () => {
  function repDeletePermSet() {
    return resolvePermissions(
      [
        { permission: 'quote:read', scope: 'own', hiddenFields: [] },
        { permission: 'quote:delete', scope: 'own', hiddenFields: [] },
      ],
      null,
      PERMISSIONS
    );
  }

  it('403s without quote:delete', async () => {
    currentPermSet = repPermSet(); // quote:read only, no delete grant
    mockFindById.mockResolvedValue({ quote_id: 1, sales_rep_list_id: 'REP-123' });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it("404s (not 403) when a rep (own scope) deletes another rep's quote", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repDeletePermSet();
    mockFindById.mockResolvedValue({ quote_id: 1, sales_rep_list_id: 'OTHER-REP' });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('a rep (own scope) can delete their own quote', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repDeletePermSet();
    mockFindById.mockResolvedValue({ quote_id: 1, sales_rep_list_id: 'REP-123' });
    mockExecQuery.mockResolvedValue({ rows: [{ quote_id: 1 }] });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('admin (all scope) deletes any quote with no ownership check', async () => {
    mockFindById.mockResolvedValue({ quote_id: 1, sales_rep_list_id: 'ANY-REP' });
    mockExecQuery.mockResolvedValue({ rows: [{ quote_id: 1 }] });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});

// ---- Line items: per-row child routes under quoteGridLine:* (migration 094) ----

/** Answer execQuery by SQL shape; anything unmatched resolves to no rows. */
function routeSql(handlers: [RegExp, (params: any[]) => any[]][]) {
  mockExecQuery.mockImplementation(async (...a: any[]) => {
    // execQuery(env, sql, params, label) vs transaction q(sql, params)
    const [sql, params] = typeof a[0] === 'string' ? [a[0], a[1]] : [a[1], a[2]];
    for (const [re, fn] of handlers) if (re.test(sql)) return { rows: fn(params ?? []), rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}
const lineSqls = () => mockExecQuery.mock.calls.map((a: any[]) => (typeof a[0] === 'string' ? a[0] : a[1]) as string);
const json = (method: string, body: any): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('line items', () => {
  beforeEach(() => {
    mockFindById.mockResolvedValue({ quote_id: 7, sales_rep_list_id: 'REP-OTHER' });
  });

  it('catalog derives quoteGridLine:read/create/write/delete from quoteGridLineSchema', () => {
    expect(PERMISSIONS).toEqual(expect.arrayContaining(['quoteGridLine:read', 'quoteGridLine:create', 'quoteGridLine:write', 'quoteGridLine:delete']));
  });

  it('quote:write alone does not allow adding a line', async () => {
    currentPermSet = resolvePermissions([{ permission: 'quote:write', scope: 'all', hiddenFields: [] }], null, PERMISSIONS);
    const res = await req('/7/lines', json('POST', { quantity: 1 }));
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('quoteGridLine:write alone allows editing a line without quote:write', async () => {
    currentPermSet = resolvePermissions([{ permission: 'quoteGridLine:write', scope: 'all', hiddenFields: [] }], null, PERMISSIONS);
    routeSql([
      [/FOR UPDATE/, () => [{ quote_line_id: 3, quote_id: 7, quantity: '1', rate: '5', qb_item_id: null, item_name: 'Custom' }]],
      [/UPDATE public\.quote_line/, () => [{ quote_line_id: 3, quote_id: 7, quantity: 2, rate: 5, amount: 10 }]],
      [/UPDATE public\.quote SET total/, () => [{ total: '10.00' }]],
    ]);
    const res = await req('/7/lines/3', json('PUT', { quantity: 2 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.parent).toEqual({ total: '10.00' });
  });

  it('own-scoped quoteGridLine grant 404s on another rep\'s quote', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = resolvePermissions([{ permission: 'quoteGridLine:create', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
    const res = await req('/7/lines', json('POST', { quantity: 1 }));
    expect(res.status).toBe(404);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('POST computes amount, takes item_name from qb_item, ignores client amount/item_name, re-sums total', async () => {
    let inserted: any[] = [];
    routeSql([
      [/FROM public\.qb_item/, () => [{ full_name: 'Meter:16-Element' }]],
      [/MAX\(line_order\)/, () => [{ n: 4 }]],
      [/INSERT INTO public\.quote_line/, (p) => { inserted = p; return [{ quote_line_id: 11, quote_id: 7 }]; }],
      [/UPDATE public\.quote SET total/, () => [{ total: '30.00' }]],
    ]);
    const res = await req('/7/lines', json('POST', {
      qb_item_id: 99, quantity: 3, rate: 10, amount: 999999, item_name: 'Spoofed', quote_id: 1, quote_line_id: 1,
    }));
    expect(res.status).toBe(201);
    const insertSql = lineSqls().find((s) => s.includes('INSERT INTO public.quote_line'))!;
    expect(insertSql).toMatch(/\(quote_id, .*line_order\)/);
    expect(inserted[0]).toBe(7); // FK from the URL, not the body's quote_id
    expect(inserted).toContain(30); // amount = 3 * 10
    expect(inserted).toContain('Meter:16-Element');
    expect(inserted).not.toContain(999999);
    expect(inserted).not.toContain('Spoofed');
    expect(inserted[inserted.length - 1]).toBe(4); // next line_order
    expect((await res.json()).data.parent).toEqual({ total: '30.00' });
  });

  it('400s on an item id that is not in the catalog', async () => {
    routeSql([[/MAX\(line_order\)/, () => [{ n: 0 }]]]);
    const res = await req('/7/lines', json('POST', { qb_item_id: 12345, quantity: 1, rate: 1 }));
    expect(res.status).toBe(400);
    expect(lineSqls().some((s) => s.includes('INSERT INTO public.quote_line'))).toBe(false);
  });

  it('400s a fractional quantity (whole units only)', async () => {
    routeSql([[/MAX\(line_order\)/, () => [{ n: 0 }]]]);
    const res = await req('/7/lines', json('POST', { quantity: 2.5, rate: 1 }));
    expect(res.status).toBe(400);
    expect(lineSqls().some((s) => s.includes('INSERT INTO public.quote_line'))).toBe(false);
  });

  it('404s editing a line that belongs to a different quote', async () => {
    routeSql([]); // SELECT ... WHERE quote_line_id AND quote_id FOR UPDATE finds nothing
    const res = await req('/7/lines/3', json('PUT', { quantity: 2 }));
    expect(res.status).toBe(404);
  });

  it('DELETE needs quoteGridLine:delete', async () => {
    currentPermSet = resolvePermissions([{ permission: 'quoteGridLine:write', scope: 'all', hiddenFields: [] }], null, PERMISSIONS);
    const res = await req('/7/lines/3', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('DELETE removes the row and returns the re-summed total', async () => {
    routeSql([
      [/DELETE FROM public\.quote_line/, () => [{ quote_line_id: 3 }]],
      [/UPDATE public\.quote SET total/, () => [{ total: '0.00' }]],
    ]);
    const res = await req('/7/lines/3', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.parent).toEqual({ total: '0.00' });
  });

  it('quote PUT no longer accepts lines or total', async () => {
    routeSql([]);
    const res = await req('/7', json('PUT', { lines: [{ desc: 'x' }], total: 1 }));
    expect(res.status).toBe(400);
    expect(lineSqls().some((s) => /quote_line|SET total/.test(s))).toBe(false);
  });
});
