import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePermissions, fullAccess } from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from '../permissions';

// Controllable auth + resolved permission set, applied by the mocked
// requirePermission the same way the real one parks it on the context.
let currentUser: any = { id: 'admin', sales_rep_list_id: null };
let currentPermSet = fullAccess(PERMISSIONS);

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
    c.set('permissions', currentPermSet);
    return next();
  },
}));

const mockFindAll = vi.fn();
const mockFindById = vi.fn();
const mockUpdate = vi.fn();
vi.mock('../crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crud')>();
  return {
    ...actual,
    findAll: (...a: any[]) => mockFindAll(...a),
    findById: (...a: any[]) => mockFindById(...a),
    update: (...a: any[]) => mockUpdate(...a),
  };
});

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

const mockQueueFieldPush = vi.fn();
vi.mock('../qbwc/pushQueue', () => ({
  queueFieldPush: (...a: any[]) => mockQueueFieldPush(...a),
}));

import ordersApp from './orders';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => ordersApp.request(path, init, ENV);
const json = (method: string, body: any) => ({
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

/** A rep's order:read/write grant, hiding money columns, scoped to their own rows. */
function repPermSet(hiddenFields: string[] = ['sold_for', 'commission']) {
  return resolvePermissions(
    [{ permission: 'order:read', scope: 'own', hiddenFields }],
    null,
    PERMISSIONS
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin', sales_rep_list_id: null };
  currentPermSet = fullAccess(PERMISSIONS);
});

describe('permission gate', () => {
  it('403s GET / without order:read', async () => {
    currentPermSet = resolvePermissions([], null, PERMISSIONS);
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockFindAll).not.toHaveBeenCalled();
  });

  it('403s PUT without order:write', async () => {
    currentPermSet = resolvePermissions([{ permission: 'order:read', scope: 'all', hiddenFields: [] }], null, PERMISSIONS);
    const res = await req('/9', json('PUT', { notes: 'x' }));
    expect(res.status).toBe(403);
  });
});

describe('GET / scoping', () => {
  it('admin (all scope) sees every order, no sales_rep_list_id filter', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.where).toEqual({ qb_deleted_at: null });
  });

  it('a rep (own scope) is filtered to their linked sales_rep_list_id', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.where).toEqual({ sales_rep_list_id: 'REP-123', qb_deleted_at: null });
  });

  it('an unlinked rep (no sales_rep_list_id) gets a filter that can never match a real order', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.where.sales_rep_list_id).toBe('__unlinked__');
  });

  it('strips hidden money fields from every row for a scoped rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({
      rows: [{ qb_sales_order_id: 1, ref_number: 'SO-1', sold_for: 900, commission: 90 }],
      pagination: { total: 1 },
    });
    const res = await req('/');
    const body: any = await res.json();
    expect(body.data.items).toEqual([{ qb_sales_order_id: 1, ref_number: 'SO-1' }]);
  });

  it('a field filter cannot override the security scope (scope is applied after)', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?sales_rep_list_id=SOMEONE-ELSE');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.where.sales_rep_list_id).toBe('REP-123');
  });
});

describe('GET / status chip filter', () => {
  it('no chips param -> no whereRaw filter (all rows)', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toEqual([]);
  });

  it('a single chip becomes one whereRaw clause for that chip only', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?chips=notInvoiced');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toHaveLength(1);
    expect(opts.whereRaw[0].sql).toContain('actual_ship_date IS NOT NULL');
    expect(opts.whereRaw[0].sql).toContain('invoice_number IS NULL');
    expect(opts.whereRaw[0].sql).not.toContain('OR');
  });

  it("multiple chips are OR'd together in a single clause (match any)", async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?chips=notInvoiced,notShipped');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toHaveLength(1);
    expect(opts.whereRaw[0].sql).toMatch(/^\(\(.*\) OR \(.*\)\)$/);
  });

  it('ignores an unrecognized chip value', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?chips=bogus');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toEqual([]);
  });

  it('is kept out of the generic field-filter where (chips is a reserved key)', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?chips=notInvoiced');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.where).toEqual({ qb_deleted_at: null });
  });
});

describe('GET / default date floor', () => {
  it('excludes orders on/before 2022-06-30 by default', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRange).toEqual({ txn_date: { gte: '2022-07-01' } });
  });
});

describe('GET /:id', () => {
  it('404s a soft-deleted order', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 1, qb_deleted_at: '2026-01-01' });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it("404s (as 'Not found') when a rep requests another rep's order", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_sales_order_id: 1, sales_rep_list_id: 'OTHER-REP', qb_deleted_at: null });
    const res = await req('/1');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, message: 'Not found' });
  });

  it('404s an unlinked rep even for an order with no assigned rep (both null)', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_sales_order_id: 1, sales_rep_list_id: null, qb_deleted_at: null });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it('returns the redacted row for the owning rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({
      qb_sales_order_id: 1, sales_rep_list_id: 'REP-123', qb_deleted_at: null, sold_for: 900,
    });
    const res = await req('/1');
    expect(res.status).toBe(200);
    expect((await res.json()).data.sold_for).toBeUndefined();
  });
});

describe('PUT /:id', () => {
  it('only writes WRITABLE fields, silently drops the rest', async () => {
    mockUpdate.mockResolvedValue({ qb_sales_order_id: 9, txn_id: 't1' });
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9 });
    await req('/9', json('PUT', { notes: 'ok', qb_sales_order_id: 999, sales_rep: 'hacked' }));
    expect(mockUpdate).toHaveBeenCalledWith(
      ENV, 'qb_sales_order', 'qb_sales_order_id', '9', { notes: 'ok' }, { touchUpdatedAt: false }
    );
  });

  it('400s when the body has no editable or pushable fields', async () => {
    const res = await req('/9', json('PUT', { qb_sales_order_id: 999 }));
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('404s an own-scoped write to an order the rep does not own', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = resolvePermissions(
      [{ permission: 'order:write', scope: 'own', hiddenFields: [] }],
      null, PERMISSIONS
    );
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, sales_rep_list_id: 'OTHER' });
    const res = await req('/9', json('PUT', { notes: 'x' }));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('404s when the order is not found', async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await req('/9', json('PUT', { notes: 'x' }));
    expect(res.status).toBe(404);
  });

  it('routes a QB-owned pushable field to the push queue, not a direct update', async () => {
    mockFindById.mockResolvedValueOnce({ qb_sales_order_id: 9, txn_id: 'TXN-1' }); // resolve txnId
    mockFindById.mockResolvedValueOnce({ qb_sales_order_id: 9, memo: 'new memo' }); // final re-fetch
    const res = await req('/9', json('PUT', { memo: 'new memo' }));
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockQueueFieldPush).toHaveBeenCalledWith(ENV, 'SalesOrder', 'TXN-1', 'memo', 'new memo');
  });
});

describe('GET /lookup-po/:po', () => {
  it('400s an empty/whitespace po', async () => {
    const res = await req('/lookup-po/%20');
    expect(res.status).toBe(400);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('trims the po before querying, and queries an exact (not partial) match', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    await req('/lookup-po/%20PO-100%20');
    expect(mockExecQuery.mock.calls[0][2]).toEqual(['PO-100']);
    expect(mockExecQuery.mock.calls[0][1]).toContain('lower(btrim(po_number)) = lower($1)');
  });

  it('returns the single matching order for an admin', async () => {
    mockExecQuery.mockResolvedValue({
      rows: [{ qb_sales_order_id: 5, ref_number: 'SO-5', customer_name: 'Acme', po_number: 'PO-100', sales_rep_list_id: null }],
    });
    const res = await req('/lookup-po/PO-100');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toEqual([{ qb_sales_order_id: 5, ref_number: 'SO-5', customer_name: 'Acme', po_number: 'PO-100', sales_rep_list_id: null }]);
  });

  it('filters out orders that do not belong to an own-scoped rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockExecQuery.mockResolvedValue({
      rows: [{ qb_sales_order_id: 5, ref_number: 'SO-5', sales_rep_list_id: 'OTHER-REP' }],
    });
    const res = await req('/lookup-po/PO-100');
    const body: any = await res.json();
    expect(body.data).toEqual([]);
  });
});

describe('create/delete are QB-sync-only', () => {
  it('405s POST /', async () => {
    const res = await req('/', json('POST', {}));
    expect(res.status).toBe(405);
  });

  it('405s DELETE /:id', async () => {
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});
