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
vi.mock('../crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crud')>();
  return {
    ...actual,
    findAll: (...a: any[]) => mockFindAll(...a),
    findById: (...a: any[]) => mockFindById(...a),
    create: (...a: any[]) => mockCreate(...a),
    update: (...a: any[]) => mockUpdate(...a),
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
  it('stamps the caller as users_id, ignoring any client-supplied one', async () => {
    currentUser = { id: 'rep-uuid' };
    currentPermSet = ownPermSet();
    mockCreate.mockResolvedValue({ support_ticket_id: 1 });
    await req('/', json('POST', { title: 'Help', users_id: 'someone-else' }));
    expect(mockCreate.mock.calls[0][2]).toMatchObject({ users_id: 'rep-uuid', title: 'Help', status: 'open' });
  });

  it('400s with no title', async () => {
    const res = await req('/', json('POST', { title: '  ' }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
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
