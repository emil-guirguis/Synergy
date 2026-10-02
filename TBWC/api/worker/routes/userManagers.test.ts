import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentGrants: string[] = ['user:read', 'user:write'];

const mockClearProfileCache = vi.fn();
vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', { id: 'admin' });
    c.set('userId', 'admin');
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) =>
    currentGrants.includes(permission)
      ? next()
      : c.json({ success: false, message: 'Insufficient permissions' }, 403),
  clearProfileCache: (...a: any[]) => mockClearProfileCache(...a),
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import userManagersApp from './userManagers';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => userManagersApp.request(path, init, ENV);
const json = (method: string, body: any) => ({
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.clearAllMocks();
  currentGrants = ['user:read', 'user:write'];
});

describe('permission gate', () => {
  it('403s GET / without user:read', async () => {
    currentGrants = [];
    const res = await req('/?manager_id=m1');
    expect(res.status).toBe(403);
  });

  it('403s POST / without user:write', async () => {
    currentGrants = ['user:read'];
    const res = await req('/', json('POST', { manager_id: 'm1', managed_user_id: 'u2' }));
    expect(res.status).toBe(403);
  });
});

describe('GET /', () => {
  it('400 when manager_id is missing', async () => {
    const res = await req('/');
    expect(res.status).toBe(400);
  });

  it('lists managed users joined with their name/email', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ user_manager_id: 1, managed_user_id: 'u2', first_name: 'A', last_name: 'B', email: 'a@b.com' }] });
    const res = await req('/?manager_id=m1');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(mockExecQuery.mock.calls[0][2]).toEqual(['m1']);
  });
});

describe('POST /', () => {
  it('400 when either id is missing', async () => {
    const res = await req('/', json('POST', { manager_id: 'm1' }));
    expect(res.status).toBe(400);
  });

  it('400 when a user is posted as managing themselves', async () => {
    const res = await req('/', json('POST', { manager_id: 'm1', managed_user_id: 'm1' }));
    expect(res.status).toBe(400);
  });

  it('creates the row, clears the profile/permission caches, and returns the joined row', async () => {
    mockExecQuery
      .mockResolvedValueOnce({ rows: [{ user_manager_id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ user_manager_id: 7, managed_user_id: 'u2', first_name: 'A', last_name: 'B', email: 'a@b.com' }] });
    const res = await req('/', json('POST', { manager_id: 'm1', managed_user_id: 'u2' }));
    expect(res.status).toBe(201);
    expect(mockClearProfileCache).toHaveBeenCalled();
    const body: any = await res.json();
    expect(body.data.user_manager_id).toBe(7);
  });

  it('409 when the pair already exists (unique_violation)', async () => {
    mockExecQuery.mockRejectedValueOnce({ code: '23505' });
    const res = await req('/', json('POST', { manager_id: 'm1', managed_user_id: 'u2' }));
    expect(res.status).toBe(409);
  });
});

describe('DELETE /:id', () => {
  it('removes the row and clears the cache', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ user_manager_id: 7 }] });
    const res = await req('/7', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mockClearProfileCache).toHaveBeenCalled();
  });

  it('404 when nothing was deleted', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/7', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
