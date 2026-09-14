import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePermissions, fullAccess } from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from '../permissions';

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
vi.mock('../crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crud')>();
  return {
    ...actual,
    findAll: (...a: any[]) => mockFindAll(...a),
    findById: (...a: any[]) => mockFindById(...a),
  };
});

import invoicesApp from './invoices';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => invoicesApp.request(path, init, ENV);

function repPermSet() {
  return resolvePermissions([{ permission: 'invoice:read', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin', sales_rep_list_id: null };
  currentPermSet = fullAccess(PERMISSIONS);
});

describe('permission gate', () => {
  it('403s without invoice:read', async () => {
    currentPermSet = resolvePermissions([], null, PERMISSIONS);
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockFindAll).not.toHaveBeenCalled();
  });
});

describe('GET / scoping', () => {
  it('admin (all scope) sees every invoice, no rep filter', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].where).toEqual({ qb_deleted_at: null });
  });

  it("a rep (own scope) is filtered to their linked sales_rep_list_id", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].where).toEqual({ sales_rep_list_id: 'REP-123', qb_deleted_at: null });
  });

  it('an unlinked rep gets a filter that can never match a real invoice', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].where.sales_rep_list_id).toBe('__unlinked__');
  });

  it('a crafted sales_rep_list_id query param cannot widen a rep\'s scope', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?sales_rep_list_id=SOMEONE-ELSE');
    expect(mockFindAll.mock.calls[0][1].where.sales_rep_list_id).toBe('REP-123');
  });

  it('does not redact any columns for the owning rep (unlike orders)', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({
      rows: [{ qb_invoice_id: 1, total: 500, balance_remaining: 500, is_paid: false }],
      pagination: { total: 1 },
    });
    const res = await req('/');
    expect((await res.json()).data.items).toEqual([
      { qb_invoice_id: 1, total: 500, balance_remaining: 500, is_paid: false },
    ]);
  });
});

describe('GET /:id', () => {
  it('404s a soft-deleted invoice', async () => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: '2026-01-01' });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it("404s (not 403) when a rep requests another rep's invoice", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, sales_rep_list_id: 'OTHER-REP', qb_deleted_at: null });
    const res = await req('/1');
    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe('Invoice not found');
  });

  it('404s an unlinked rep even for an invoice with no assigned rep (both null)', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, sales_rep_list_id: null, qb_deleted_at: null });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it('returns the full row (no redaction) for the owning rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, sales_rep_list_id: 'REP-123', qb_deleted_at: null, total: 500 });
    const res = await req('/1');
    expect(res.status).toBe(200);
    expect((await res.json()).data.total).toBe(500);
  });
});
