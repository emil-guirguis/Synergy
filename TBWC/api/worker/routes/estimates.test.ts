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
}));

const mockQueueFieldPush = vi.fn();
const mockPromoteQueuedPush = vi.fn();
vi.mock('../qbwc/pushQueue', () => ({
  queueFieldPush: (...a: any[]) => mockQueueFieldPush(...a),
  promoteQueuedPush: (...a: any[]) => mockPromoteQueuedPush(...a),
}));

import estimatesApp from './estimates';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => estimatesApp.request(path, init, ENV);

function repPermSet() {
  return resolvePermissions([{ permission: 'estimate:read', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin', sales_rep_list_id: null };
  currentPermSet = fullAccess(PERMISSIONS);
});

describe('permission gate', () => {
  it('403s GET / without estimate:read', async () => {
    currentPermSet = resolvePermissions([], null, PERMISSIONS);
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockFindAll).not.toHaveBeenCalled();
  });
});

describe('GET / scoping', () => {
  it('admin (all scope) sees every estimate, no rep filter', async () => {
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

  it('an unlinked rep (manages nobody) gets a filter that can never match a real estimate', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].whereRaw).toEqual([{ sql: '1 = 0' }]);
  });
});

describe('GET /:id scoping', () => {
  it("404s (not 403) when a rep requests another rep's estimate", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_estimate_id: 1, sales_rep_list_id: 'OTHER-REP' });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it("a managing rep can see a managed user's estimate", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123', managed_sales_rep_list_ids: ['REP-456'] };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_estimate_id: 1, sales_rep_list_id: 'REP-456' });
    const res = await req('/1');
    expect(res.status).toBe(200);
  });
});
