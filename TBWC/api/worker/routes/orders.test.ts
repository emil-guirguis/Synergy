import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePermissions, fullAccess } from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from '../permissions';

// Controllable auth + resolved permission set, applied by the mocked
// requirePermission the same way the real one parks it on the context.
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

// Every GET / carries this trailing whereRaw clause regardless of scope —
// see 'GET / default date floor' below — so scope/chip assertions elsewhere
// check for it explicitly rather than asserting an exhaustive array without it.
const DATE_FLOOR_CLAUSE = { sql: "(order_type IN ('hold_for_release', 'consignment') OR txn_date >= '2022-07-01')" };

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
    expect(opts.where).toEqual({ qb_deleted_at: null });
    expect(opts.whereRaw).toEqual([{ sql: 'sales_rep_list_id IN (?)', params: ['REP-123'] }, DATE_FLOOR_CLAUSE]);
  });

  it('a rep who manages others is scoped to their own rep plus every managed rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123', managed_sales_rep_list_ids: ['REP-456', 'REP-789'] };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toEqual([
      { sql: 'sales_rep_list_id IN (?, ?, ?)', params: ['REP-123', 'REP-456', 'REP-789'] },
      DATE_FLOOR_CLAUSE,
    ]);
  });

  it('an unlinked rep (no sales_rep_list_id, manages nobody) gets a filter that can never match a real order', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toEqual([{ sql: '1 = 0' }, DATE_FLOOR_CLAUSE]);
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
    // whereFromQuery still parses the (ignored) field filter into `where`,
    // but the real scope lives in whereRaw and always wins.
    expect(opts.whereRaw).toEqual([{ sql: 'sales_rep_list_id IN (?)', params: ['REP-123'] }, DATE_FLOOR_CLAUSE]);
  });
});

describe('GET / status chip filter', () => {
  it('no chips param -> only the date-floor whereRaw clause (all rows)', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toEqual([DATE_FLOOR_CLAUSE]);
  });

  it('a single chip becomes one whereRaw clause for that chip only', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?chips=notInvoiced');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toHaveLength(2);
    expect(opts.whereRaw[0].sql).toContain("invoice_status = 'Not Invoiced'");
    expect(opts.whereRaw[0].sql).toContain('actual_ship_date IS NOT NULL');
    expect(opts.whereRaw[0].sql).not.toContain('OR');
    expect(opts.whereRaw[1]).toEqual(DATE_FLOOR_CLAUSE);
  });

  it("multiple chips are OR'd together in a single clause (match any)", async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?chips=notInvoiced,notShipped');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toHaveLength(2);
    expect(opts.whereRaw[0].sql).toMatch(/^\(\(.*\) OR \(.*\)\)$/);
  });

  it('ignores an unrecognized chip value', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?chips=bogus');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toEqual([DATE_FLOOR_CLAUSE]);
  });

  it('is kept out of the generic field-filter where (chips is a reserved key)', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?chips=notInvoiced');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.where).toEqual({ qb_deleted_at: null });
  });
});

describe('GET / default date floor', () => {
  it('excludes orders on/before 2022-06-30 by default, except hold-for-release rows', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toContainEqual(DATE_FLOOR_CLAUSE);
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
    mockExecQuery.mockResolvedValue({ rows: [] }); // latestInvoiceSerialNumbers
    const res = await req('/1');
    expect(res.status).toBe(200);
    expect((await res.json()).data.sold_for).toBeUndefined();
  });

  // serial_numbers is not a column: it is parsed out of the latest linked
  // invoice's line descriptions on every read (orderSerials.ts).
  it('attaches the serial block parsed off the linked invoice', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 1, txn_id: 't1', qb_deleted_at: null });
    mockExecQuery.mockResolvedValue({
      rows: [{
        ref_number: '10503',
        txn_date: '2026-10-20',
        lines: [
          { item: 'DI-4W/50-N1-KIT.xx', desc: 'Smart Meter.\n\nSerial #: P032609156' },
          { item: 'CT-RGT12-0050-U', desc: '50-Amp Split-Core CT, 36" leads' },
        ],
      }],
    });
    const res = await req('/1');
    expect((await res.json()).data.serial_numbers).toEqual({
      invoice_ref: '10503',
      invoice_date: '2026-10-20',
      items: [{
        item: 'DI-4W/50-N1-KIT.xx',
        desc: 'Smart Meter.\n\nSerial #: P032609156',
        serials: ['P032609156'],
      }],
    });
  });

  it('leaves the serial block null when no invoice is linked', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 1, txn_id: 't1', qb_deleted_at: null });
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/1');
    expect((await res.json()).data.serial_numbers).toBeNull();
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
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9 });
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

  // The response is shaped like GET /:id's: redacted by the caller's own
  // order:read grant (a role can hold order:write while hiding money) and
  // carrying the re-read serial block, which is not a column.
  it('redacts the saved row and re-attaches the serial block', async () => {
    currentPermSet = resolvePermissions(
      [{ permission: 'order:read', scope: 'all', hiddenFields: ['sold_for'] },
       { permission: 'order:write', scope: 'all', hiddenFields: [] }],
      null, PERMISSIONS
    );
    mockFindById.mockResolvedValueOnce({ qb_sales_order_id: 9, txn_id: 't1' }); // existing
    mockUpdate.mockResolvedValue({ qb_sales_order_id: 9 });
    mockFindById.mockResolvedValueOnce({ qb_sales_order_id: 9, txn_id: 't1', sold_for: 900 }); // re-fetch
    mockExecQuery.mockResolvedValue({ rows: [{ ref_number: '10503', txn_date: '2026-10-20', lines: [] }] });
    const res = await req('/9', json('PUT', { notes: 'ok' }));
    const body = await res.json();
    expect(body.data.sold_for).toBeUndefined();
    expect(body.data.serial_numbers).toEqual({ invoice_ref: '10503', invoice_date: '2026-10-20', items: [] });
  });

  it('routes a QB-owned pushable field to the push queue, not a direct update', async () => {
    mockFindById.mockResolvedValueOnce({ qb_sales_order_id: 9, txn_id: 'TXN-1' }); // existing (fetched upfront)
    mockFindById.mockResolvedValueOnce({ qb_sales_order_id: 9, memo: 'new memo' }); // final re-fetch
    const res = await req('/9', json('PUT', { memo: 'new memo' }));
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockQueueFieldPush).toHaveBeenCalledWith(ENV, 'SalesOrder', 'TXN-1', 'memo', 'new memo');
  });

  it('writes header fields and memo directly for a hold_for_release order, never queuing a push', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'hold_for_release', txn_id: 'HOLD-1' });
    mockUpdate.mockResolvedValue({ qb_sales_order_id: 9, txn_id: 'HOLD-1' });
    const res = await req('/9', json('PUT', { ref_number: 'HFR-1', memo: 'hi', jay: true }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      ENV, 'qb_sales_order', 'qb_sales_order_id', '9',
      { ref_number: 'HFR-1', memo: 'hi', jay: true }, { touchUpdatedAt: false }
    );
    expect(mockQueueFieldPush).not.toHaveBeenCalled();
  });

  it("resolves and writes customer_list_id/customer_name together, never a raw customer_name, for a hold_for_release order", async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'hold_for_release', txn_id: 'HOLD-1' });
    mockExecQuery.mockResolvedValue({ rows: [{ full_name: 'Acme Corp' }] }); // resolveCustomer
    mockUpdate.mockResolvedValue({ qb_sales_order_id: 9, txn_id: 'HOLD-1' });
    const res = await req('/9', json('PUT', { customer_list_id: 'CUST-1', customer_name: 'Hacked Name' }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      ENV, 'qb_sales_order', 'qb_sales_order_id', '9',
      { customer_list_id: 'CUST-1', customer_name: 'Acme Corp' }, { touchUpdatedAt: false }
    );
  });

  it('writes lines via its own ::jsonb statement and recomputes total, for a hold_for_release order', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'hold_for_release', txn_id: 'HOLD-1' });
    mockExecQuery.mockResolvedValue({ rows: [] });
    const lines = [{ item: 'Widget', itemValue: 'INV-1', desc: 'A widget', quantity: 2, rate: 5, amount: 10 }];
    const res = await req('/9', json('PUT', { lines }));
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled(); // no WRITABLE/HOLD_WRITABLE key in this request
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining('SET lines = $1::jsonb, total = $2'),
      [JSON.stringify(lines), 10, '9'],
      'orders.updateLinesHold'
    );
  });

  it('400s a hold_for_release PUT with neither editable fields nor lines', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'hold_for_release', txn_id: 'HOLD-1' });
    const res = await req('/9', json('PUT', {}));
    expect(res.status).toBe(400);
  });

  it('ignores a lines edit on a normal (order_type: order) row — never reaches the ::jsonb statement', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'order', txn_id: 'TXN-1' });
    const res = await req('/9', json('PUT', { lines: [{ item: 'Widget' }] }));
    expect(res.status).toBe(400); // nothing else in the body is WRITABLE either
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('400s an unknown customer_list_id on a hold_for_release order', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'hold_for_release', txn_id: 'HOLD-1' });
    mockExecQuery.mockResolvedValue({ rows: [] }); // resolveCustomer finds nothing
    const res = await req('/9', json('PUT', { customer_list_id: 'BOGUS' }));
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('POST / creates a Hold for Release order', () => {
  it('400s with no customer_list_id', async () => {
    const res = await req('/', json('POST', { ref_number: 'HFR-1' }));
    expect(res.status).toBe(400);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('400s an unknown customer_list_id', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] }); // resolveCustomer finds nothing
    const res = await req('/', json('POST', { customer_list_id: 'BOGUS' }));
    expect(res.status).toBe(400);
  });

  it('inserts order_type=hold_for_release, a synthetic txn_id, the resolved customer, a default txn_date, and only HOLD_WRITABLE body fields', async () => {
    mockExecQuery.mockResolvedValueOnce({ rows: [{ full_name: 'Acme Corp' }] }); // resolveCustomer
    mockExecQuery.mockResolvedValueOnce({ rows: [{ qb_sales_order_id: 42, order_type: 'hold_for_release' }] }); // create()
    const res = await req('/', json('POST', {
      customer_list_id: 'CUST-1', customer_name: 'Hacked Name', ref_number: 'HFR-1',
      qb_sales_order_id: 999, sales_rep: 'hacked',
    }));
    expect(res.status).toBe(201);
    const [, sql, values] = mockExecQuery.mock.calls[1];
    const columns = sql.match(/INSERT INTO "qb_sales_order" \(([^)]+)\)/)[1].split(', ');
    expect(columns).toEqual(expect.arrayContaining(['order_type', 'txn_id', 'customer_list_id', 'customer_name', 'ref_number', 'txn_date']));
    expect(columns).not.toContain('qb_sales_order_id');
    expect(columns).not.toContain('sales_rep');
    expect(values[columns.indexOf('order_type')]).toBe('hold_for_release');
    expect(values[columns.indexOf('txn_id')]).toMatch(/^HOLD-/);
    // Resolved server-side, not the (hacked) client-supplied name.
    expect(values[columns.indexOf('customer_name')]).toBe('Acme Corp');
    expect(values[columns.indexOf('txn_date')]).toBe(new Date().toISOString().slice(0, 10));
  });

  it('creates a consignment order when order_type is given, same insert shape otherwise', async () => {
    mockExecQuery.mockResolvedValueOnce({ rows: [{ full_name: 'Acme Corp' }] }); // resolveCustomer
    mockExecQuery.mockResolvedValueOnce({ rows: [{ qb_sales_order_id: 43, order_type: 'consignment' }] }); // create()
    const res = await req('/', json('POST', { customer_list_id: 'CUST-1', order_type: 'consignment' }));
    expect(res.status).toBe(201);
    const [, sql, values] = mockExecQuery.mock.calls[1];
    const columns = sql.match(/INSERT INTO "qb_sales_order" \(([^)]+)\)/)[1].split(', ');
    expect(values[columns.indexOf('order_type')]).toBe('consignment');
  });

  it('400s an order_type outside the creatable placeholder set, before ever resolving the customer', async () => {
    const res = await req('/', json('POST', { customer_list_id: 'CUST-1', order_type: 'order' }));
    expect(res.status).toBe(400);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('honours an explicit txn_date instead of defaulting to today', async () => {
    mockExecQuery.mockResolvedValueOnce({ rows: [{ full_name: 'Acme Corp' }] });
    mockExecQuery.mockResolvedValueOnce({ rows: [{ qb_sales_order_id: 42 }] });
    await req('/', json('POST', { customer_list_id: 'CUST-1', txn_date: '2026-01-15' }));
    const [, sql, values] = mockExecQuery.mock.calls[1];
    const columns = sql.match(/INSERT INTO "qb_sales_order" \(([^)]+)\)/)[1].split(', ');
    expect(values[columns.indexOf('txn_date')]).toBe('2026-01-15');
  });

  it('computes total from lines given up front and persists them via a follow-up ::jsonb statement', async () => {
    mockExecQuery.mockResolvedValueOnce({ rows: [{ full_name: 'Acme Corp' }] }); // resolveCustomer
    mockExecQuery.mockResolvedValueOnce({ rows: [{ qb_sales_order_id: 42 }] }); // create()
    mockExecQuery.mockResolvedValueOnce({ rows: [] }); // follow-up lines UPDATE
    const lines = [
      { item: 'Widget', itemValue: 'INV-1', desc: 'A widget', quantity: 2, rate: 5, amount: 10 },
      { item: 'Gadget', itemValue: 'INV-2', desc: 'A gadget', quantity: 1, rate: 3.5, amount: 3.5 },
    ];
    const res = await req('/', json('POST', { customer_list_id: 'CUST-1', lines }));
    expect(res.status).toBe(201);
    const [, insertSql, insertValues] = mockExecQuery.mock.calls[1];
    const columns = insertSql.match(/INSERT INTO "qb_sales_order" \(([^)]+)\)/)[1].split(', ');
    expect(columns).not.toContain('lines'); // never through the generic INSERT (no cast there)
    expect(insertValues[columns.indexOf('total')]).toBe(13.5);
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV, expect.stringContaining('SET lines = $1::jsonb'), [JSON.stringify(lines), 42], 'orders.createLinesHold'
    );
    const body: any = await res.json();
    expect(body.data.lines).toEqual(lines);
  });

  it('omits the follow-up lines statement with no lines given', async () => {
    mockExecQuery.mockResolvedValueOnce({ rows: [{ full_name: 'Acme Corp' }] });
    mockExecQuery.mockResolvedValueOnce({ rows: [{ qb_sales_order_id: 42 }] });
    await req('/', json('POST', { customer_list_id: 'CUST-1' }));
    expect(mockExecQuery).toHaveBeenCalledTimes(2);
  });
});

describe('DELETE /:id', () => {
  it("405s a normal (order_type: 'order') row — QuickBooks manages it", async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'order' });
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('deletes a hold_for_release placeholder', async () => {
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'hold_for_release' });
    mockExecQuery.mockResolvedValue({ rows: [{ qb_sales_order_id: 9 }] });
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV, expect.stringContaining('DELETE FROM public.qb_sales_order'), ['9'], 'orders.deleteHold'
    );
  });

  it('404s a nonexistent order', async () => {
    mockFindById.mockResolvedValue(null);
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // notOwnedRow — previously DELETE had no row-level check at all despite
  // requiring order:delete, unlike GET/PUT on the same table. No role grants
  // order:delete scope 'own' today (same as order:write), but the scope is
  // editable per role, so this must be honoured regardless.
  it("404s (as 'Order not found') an own-scoped delete on a hold placeholder belonging to another rep", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = resolvePermissions(
      [{ permission: 'order:delete', scope: 'own', hiddenFields: [] }],
      null, PERMISSIONS
    );
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'hold_for_release', sales_rep_list_id: 'OTHER-REP' });
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('deletes a hold placeholder for the owning own-scoped rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = resolvePermissions(
      [{ permission: 'order:delete', scope: 'own', hiddenFields: [] }],
      null, PERMISSIONS
    );
    mockFindById.mockResolvedValue({ qb_sales_order_id: 9, order_type: 'hold_for_release', sales_rep_list_id: 'REP-123' });
    mockExecQuery.mockResolvedValue({ rows: [{ qb_sales_order_id: 9 }] });
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});

describe('order email routes — ownership scoping (notOwnedRow)', () => {
  // loadOrderForEmail's own execQuery call — all 3 email routes share it.
  const EMAIL_ROW = { ref_number: 'SO-9', customer_name: 'Acme', lines: [], sales_rep_list_id: 'OTHER-REP' };

  it("GET /:id/email 404s for an own-scoped order:write caller who doesn't own the order", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = resolvePermissions(
      [{ permission: 'order:write', scope: 'own', hiddenFields: [] }],
      null, PERMISSIONS
    );
    mockExecQuery.mockResolvedValue({ rows: [EMAIL_ROW] });
    const res = await req('/9/email');
    expect(res.status).toBe(404);
  });

  it('GET /:id/email 200s for the owning own-scoped rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = resolvePermissions(
      [{ permission: 'order:write', scope: 'own', hiddenFields: [] }],
      null, PERMISSIONS
    );
    mockExecQuery.mockResolvedValue({ rows: [{ ...EMAIL_ROW, sales_rep_list_id: 'REP-123' }] });
    const res = await req('/9/email');
    expect(res.status).toBe(200);
  });

  it("POST /:id/email 404s for an own-scoped caller who doesn't own the order, before ever calling sendDocumentEmail", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = resolvePermissions(
      [{ permission: 'order:write', scope: 'own', hiddenFields: [] }],
      null, PERMISSIONS
    );
    mockExecQuery.mockResolvedValue({ rows: [{ ...EMAIL_ROW, customer_email: 'c@acme.com' }] });
    const res = await req('/9/email', json('POST', {}));
    expect(res.status).toBe(404);
  });

  it('GET /:id/email is unrestricted for an all-scope caller regardless of the order\'s rep', async () => {
    mockExecQuery.mockResolvedValue({ rows: [EMAIL_ROW] });
    const res = await req('/9/email');
    expect(res.status).toBe(200);
  });
});

// ---- lines follow their own grid grant (orderGridLine:read, migration 097) ----
describe('GET /:id lines (orderGridLine:read)', () => {
  const ORDER = {
    qb_sales_order_id: 1, sales_rep_list_id: 'REP-123', qb_deleted_at: null,
    lines: [{ item: 'CT-100', desc: 'Split core', quantity: 4, rate: 25, amount: 100 }],
  };
  beforeEach(() => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    mockFindById.mockResolvedValue(structuredClone(ORDER));
    mockExecQuery.mockResolvedValue({ rows: [] });
  });

  it('redacts each line by the grid grant (reps: no rate/amount)', async () => {
    currentPermSet = resolvePermissions([
      { permission: 'order:read', scope: 'own', hiddenFields: [] },
      { permission: 'orderGridLine:read', scope: 'own', hiddenFields: ['rate', 'amount'] },
    ], null, PERMISSIONS);
    const body = await (await req('/1')).json();
    expect(body.data.lines).toEqual([{ item: 'CT-100', desc: 'Split core', quantity: 4 }]);
  });

  it('drops lines entirely without orderGridLine:read', async () => {
    currentPermSet = resolvePermissions([{ permission: 'order:read', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
    const body = await (await req('/1')).json();
    expect(body.data.qb_sales_order_id).toBe(1);
    expect(body.data.lines).toBeUndefined();
  });

  it('full grid grant returns lines untouched', async () => {
    currentUser = { id: 'admin', sales_rep_list_id: null };
    currentPermSet = fullAccess(PERMISSIONS);
    const body = await (await req('/1')).json();
    expect(body.data.lines).toEqual(ORDER.lines);
  });
});
