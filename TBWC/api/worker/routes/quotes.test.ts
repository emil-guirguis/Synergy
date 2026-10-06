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
