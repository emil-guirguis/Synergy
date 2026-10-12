import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePermissions, fullAccess } from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from '../permissions';

let currentUser: any = { id: 'admin-uuid' };
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
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockRemove = vi.fn();
vi.mock('../crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crud')>();
  return {
    ...actual,
    findAll: (...a: any[]) => mockFindAll(...a),
    findById: (...a: any[]) => mockFindById(...a),
    create: (...a: any[]) => mockCreate(...a),
    update: (...a: any[]) => mockUpdate(...a),
    remove: (...a: any[]) => mockRemove(...a),
  };
});

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import supportApp from './support';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => supportApp.request(path, init, ENV);
const json = (method: string, body: any) => ({
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

function ownPermSet() {
  return resolvePermissions([{ permission: 'support:read', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin-uuid' };
  currentPermSet = fullAccess(PERMISSIONS);
});

describe('permission gate', () => {
  it('403s GET / without support:read', async () => {
    currentPermSet = resolvePermissions([], null, PERMISSIONS);
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockFindAll).not.toHaveBeenCalled();
  });

  it('403s PUT /:id without support:write', async () => {
    currentPermSet = ownPermSet();
    const res = await req('/1', json('PUT', { title: 'x' }));
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('GET / scoping', () => {
  it('admin (all scope) sees every ticket, no users_id filter', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].where).toEqual({});
  });

  it('a regular caller (own scope) is filtered to their own users_id', async () => {
    currentUser = { id: 'rep-uuid' };
    currentPermSet = ownPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].where).toEqual({ users_id: 'rep-uuid' });
  });

  it("a crafted users_id query param cannot widen an own-scope caller's visibility", async () => {
    currentUser = { id: 'rep-uuid' };
    currentPermSet = ownPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?users_id=someone-else');
    expect(mockFindAll.mock.calls[0][1].where).toEqual({ users_id: 'rep-uuid' });
  });
});

describe('GET /:id scoping', () => {
  it('404s when an own-scope caller requests a ticket they did not file', async () => {
    currentUser = { id: 'rep-uuid' };
    currentPermSet = ownPermSet();
    mockFindById.mockResolvedValue({ support_ticket_id: 1, users_id: 'someone-else' });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it('200s when an own-scope caller requests their own ticket', async () => {
    currentUser = { id: 'rep-uuid' };
    currentPermSet = ownPermSet();
    mockFindById.mockResolvedValue({ support_ticket_id: 1, users_id: 'rep-uuid' });
    const res = await req('/1');
    expect(res.status).toBe(200);
  });

  it('admin (all scope) can fetch any ticket', async () => {
    mockFindById.mockResolvedValue({ support_ticket_id: 1, users_id: 'someone-else' });
    const res = await req('/1');
    expect(res.status).toBe(200);
  });
});

describe('POST /', () => {
  const CONTACT = { contact_name: 'Jane Filer', contact_phone: '555-1234' };

  it('stamps the caller as users_id, ignoring any client-supplied one', async () => {
    currentUser = { id: 'rep-uuid' };
    currentPermSet = ownPermSet();
    mockCreate.mockResolvedValue({ support_ticket_id: 1 });
    mockFindById.mockResolvedValue({ support_ticket_id: 1 });
    await req('/', json('POST', { title: 'Help', users_id: 'someone-else', ...CONTACT }));
    expect(mockCreate.mock.calls[0][2]).toMatchObject({
      users_id: 'rep-uuid', title: 'Help', status: 'open',
      contact_name: 'Jane Filer', contact_phone: '555-1234',
    });
  });

  it('400s with no title', async () => {
    const res = await req('/', json('POST', { title: '  ', ...CONTACT }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400s with no contact name', async () => {
    const res = await req('/', json('POST', { title: 'Help', contact_phone: '555-1234' }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400s with no contact phone', async () => {
    const res = await req('/', json('POST', { title: 'Help', contact_name: 'Jane Filer' }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('GET /analytics', () => {
  it('403s without support:write', async () => {
    currentPermSet = ownPermSet();
    const res = await req('/analytics');
    expect(res.status).toBe(403);
  });

  it('shapes totals and by_status from the two queries', async () => {
    mockExecQuery
      .mockResolvedValueOnce({ rows: [{ total: '5', last_7d: '2', last_30d: '5', avg_resolution_hours: '3.5', avg_csat: '4.2', csat_count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'open', count: '3' }, { status: 'closed', count: '2' }] });
    const res = await req('/analytics');
    const data = await res.json();
    expect(data.data).toEqual({
      total: 5, last_7_days: 2, last_30_days: 5,
      avg_resolution_hours: 3.5, avg_csat: 4.2, csat_count: 2,
      by_status: { open: 3, closed: 2 },
    });
  });
});

describe('GET /validate-po/:po', () => {
  it('returns valid:true with order info on a match', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ order_number: 'SO-1', customer_name: 'Acme' }] });
    const res = await req('/validate-po/PO-123');
    const data = await res.json();
    expect(data.data).toEqual({ valid: true, order_number: 'SO-1', customer_name: 'Acme' });
  });

  it('returns valid:false with no match', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/validate-po/PO-nope');
    const data = await res.json();
    expect(data.data).toEqual({ valid: false });
  });
});

describe('GET /invoices-by-serial/:serial', () => {
  it('returns matching invoices', async () => {
    mockExecQuery.mockResolvedValue({
      rows: [{ qb_invoice_id: 1, invoice_number: 'INV-1', txn_date: '2026-01-01', description: 'SERIAL P12345' }],
    });
    const res = await req('/invoices-by-serial/P12345');
    const data = await res.json();
    expect(data.data).toHaveLength(1);
    expect(data.data[0]).toMatchObject({ invoice_number: 'INV-1' });
  });
});

describe('PUT /:id', () => {
  it('404s when the ticket does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    const res = await req('/1', json('PUT', { title: 'x' }));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('sets resolved_at on first transition to resolved', async () => {
    mockFindById.mockResolvedValue({ support_ticket_id: 1, resolved_at: null });
    mockUpdate.mockResolvedValue({ support_ticket_id: 1 });
    await req('/1', json('PUT', { title: 'x', status: 'resolved' }));
    expect(mockUpdate.mock.calls[0][4].resolved_at).not.toBeNull();
  });

  it('keeps the existing resolved_at across further resolved/closed edits', async () => {
    mockFindById.mockResolvedValue({ support_ticket_id: 1, resolved_at: '2026-01-01T00:00:00.000Z' });
    mockUpdate.mockResolvedValue({ support_ticket_id: 1 });
    await req('/1', json('PUT', { title: 'x', status: 'closed' }));
    expect(mockUpdate.mock.calls[0][4].resolved_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('clears resolved_at on reopening', async () => {
    mockFindById.mockResolvedValue({ support_ticket_id: 1, resolved_at: '2026-01-01T00:00:00.000Z' });
    mockUpdate.mockResolvedValue({ support_ticket_id: 1 });
    await req('/1', json('PUT', { title: 'x', status: 'open' }));
    expect(mockUpdate.mock.calls[0][4].resolved_at).toBeNull();
  });
});

describe('POST /:id/csat', () => {
  it('404s when the caller did not file this ticket', async () => {
    currentUser = { id: 'rep-uuid' };
    mockFindById.mockResolvedValue({ support_ticket_id: 1, users_id: 'someone-else', status: 'resolved' });
    const res = await req('/1/csat', json('POST', { rating: 5 }));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('400s when the ticket is not resolved/closed yet', async () => {
    currentUser = { id: 'rep-uuid' };
    mockFindById.mockResolvedValue({ support_ticket_id: 1, users_id: 'rep-uuid', status: 'open' });
    const res = await req('/1/csat', json('POST', { rating: 5 }));
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('400s on a rating outside 1-5', async () => {
    currentUser = { id: 'rep-uuid' };
    mockFindById.mockResolvedValue({ support_ticket_id: 1, users_id: 'rep-uuid', status: 'resolved' });
    const res = await req('/1/csat', json('POST', { rating: 7 }));
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('records the rating on a resolved ticket with none yet', async () => {
    currentUser = { id: 'rep-uuid' };
    mockFindById.mockResolvedValue({ support_ticket_id: 1, users_id: 'rep-uuid', status: 'resolved', csat_rating: null });
    mockUpdate.mockResolvedValue({ support_ticket_id: 1, csat_rating: 4 });
    const res = await req('/1/csat', json('POST', { rating: 4 }));
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0][4]).toMatchObject({ csat_rating: 4 });
  });

  it('is a no-op (keeps the existing rating) on a repeat call', async () => {
    currentUser = { id: 'rep-uuid' };
    mockFindById.mockResolvedValue({ support_ticket_id: 1, users_id: 'rep-uuid', status: 'resolved', csat_rating: 3 });
    const res = await req('/1/csat', json('POST', { rating: 5 }));
    const data = await res.json();
    expect(data.data.csat_rating).toBe(3);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE /:id', () => {
  it('404s when the ticket does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('400s and blocks deletion when documents are attached', async () => {
    mockFindById.mockResolvedValue({ support_ticket_id: 1 });
    mockExecQuery.mockResolvedValue({ rows: [{ count: 2 }] });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('deletes when there are no attached documents', async () => {
    mockFindById.mockResolvedValue({ support_ticket_id: 1 });
    mockExecQuery.mockResolvedValue({ rows: [{ count: 0 }] });
    mockRemove.mockResolvedValue({ support_ticket_id: 1 });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mockRemove).toHaveBeenCalled();
  });
});
