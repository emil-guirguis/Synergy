import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePermissions } from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from '../permissions';

const ALL = ['userGridManager:read', 'userGridManager:create', 'userGridManager:delete'];
let currentPermSet = resolvePermissions(ALL.map((permission) => ({ permission, scope: 'all' as const, hiddenFields: [] })), null, PERMISSIONS);
let currentUser: any = { id: 'admin' };

const mockClearProfileCache = vi.fn();
vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', currentUser);
    c.set('userId', currentUser.id);
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) => {
    if (!currentPermSet.has(permission)) return c.json({ success: false, message: 'Insufficient permissions' }, 403);
    c.set('permissions', currentPermSet);
    return next();
  },
  clearProfileCache: (...a: any[]) => mockClearProfileCache(...a),
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
  withTransaction: (_env: any, fn: any) => fn((...a: any[]) => mockExecQuery(...a)),
}));

import userManagersApp from './userManagers';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => userManagersApp.request(path, init, ENV);
const json = (method: string, body: any) => ({
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});
const grants = (list: [string, 'all' | 'own'][]) =>
  resolvePermissions(list.map(([permission, scope]) => ({ permission, scope, hiddenFields: [] })), null, PERMISSIONS);
const sqlOf = (call: any[]) => (typeof call[0] === 'string' ? call[0] : call[1]) as string;

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin' };
  currentPermSet = grants(ALL.map((p) => [p, 'all']));
});

describe('permission gate', () => {
  it('catalog derives userGridManager:read/create/delete (no write — rows are add/remove only)', () => {
    expect(PERMISSIONS).toEqual(expect.arrayContaining(ALL));
    expect(PERMISSIONS).not.toContain('userGridManager:write');
  });

  it('403s GET without userGridManager:read, even holding user:read', async () => {
    currentPermSet = grants([['user:read', 'all'], ['user:write', 'all']]);
    const res = await req('/m1');
    expect(res.status).toBe(403);
  });

  it('403s POST without userGridManager:create', async () => {
    currentPermSet = grants([['userGridManager:read', 'all']]);
    const res = await req('/m1', json('POST', { managed_user_id: 'u2' }));
    expect(res.status).toBe(403);
  });

  it("own scope: 404s on another user's Manages list", async () => {
    currentUser = { id: 'u9' };
    currentPermSet = grants([['userGridManager:read', 'own']]);
    const res = await req('/m1');
    expect(res.status).toBe(404);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('GET /:managerId', () => {
  it('lists managed users joined with their name/email', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ user_manager_id: 1, managed_user_id: 'u2', managed_user_name: 'A B', email: 'a@b.com' }] });
    const res = await req('/m1');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(mockExecQuery.mock.calls[0][2]).toEqual(['m1']);
    expect(sqlOf(mockExecQuery.mock.calls[0])).toContain('JOIN public.users u');
  });
});

describe('POST /:managerId', () => {
  it('400 when no user is picked', async () => {
    const res = await req('/m1', json('POST', {}));
    expect(res.status).toBe(400);
  });

  it('400 when a user is posted as managing themselves', async () => {
    const res = await req('/m1', json('POST', { managed_user_id: 'm1' }));
    expect(res.status).toBe(400);
  });

  it('manager comes from the URL, not the body; clears the profile cache; returns the joined row', async () => {
    mockExecQuery.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('INSERT INTO public.user_manager')) return { rows: [{ user_manager_id: 7, manager_id: params[0] }] };
      if (sql.includes('WHERE t.user_manager_id')) return { rows: [{ user_manager_id: 7, managed_user_name: 'A B' }] };
      return { rows: [] };
    });
    const res = await req('/m1', json('POST', { managed_user_id: 'u2', manager_id: 'someone-else' }));
    expect(res.status).toBe(201);
    const insert = mockExecQuery.mock.calls.find((c) => sqlOf(c).includes('INSERT'))!;
    expect(insert[1][0]).toBe('m1');
    expect(mockClearProfileCache).toHaveBeenCalled();
    const body: any = await res.json();
    expect(body.data.item.managed_user_name).toBe('A B');
  });

  it('409 when the pair already exists (unique_violation)', async () => {
    mockExecQuery.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const res = await req('/m1', json('POST', { managed_user_id: 'u2' }));
    expect(res.status).toBe(409);
  });
});

describe('DELETE /:managerId/:id', () => {
  it('removes the row and clears the cache', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ user_manager_id: 7 }] });
    const res = await req('/m1/7', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mockExecQuery.mock.calls[0][1]).toEqual(['7', 'm1']);
    expect(mockClearProfileCache).toHaveBeenCalled();
  });

  it("404 when the row isn't under that manager", async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/m1/7', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
