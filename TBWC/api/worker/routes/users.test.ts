import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable auth: adjust `currentGrants` to exercise the permission gate.
let currentUser: any = { id: 'admin' };
let currentGrants: string[] = ['user:read', 'user:write'];

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    if (!currentUser) return c.json({ success: false, message: 'Access token required' }, 401);
    c.set('user', currentUser);
    c.set('userId', currentUser.id);
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) =>
    currentGrants.includes(permission)
      ? next()
      : c.json({ success: false, message: 'Insufficient permissions' }, 403),
}));

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

const mockCreateAuthUser = vi.fn();
const mockDeleteAuthUser = vi.fn();

vi.mock('../supabaseAdmin', () => ({
  mintSessionForEmail: vi.fn(),
  createAuthUser: (...a: any[]) => mockCreateAuthUser(...a),
  deleteAuthUser: (...a: any[]) => mockDeleteAuthUser(...a),
}));

import usersApp from './users';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => usersApp.request(path, init, ENV);
const json = (method: string, body: any) => ({
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin' };
  currentGrants = ['user:read', 'user:write'];
  mockCreateAuthUser.mockResolvedValue({ id: 'auth-new' });
});

describe('permission gate', () => {
  it('403 when the caller holds no user:read grant', async () => {
    currentUser = { id: 'u2' };
    currentGrants = [];
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockFindAll).not.toHaveBeenCalled();
  });
});

describe('GET /users', () => {
  it('returns the framework list envelope {data:{items,total}}', async () => {
    mockFindAll.mockResolvedValue({ rows: [{ id: '1' }], pagination: { total: 1 } });
    const res = await req('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { items: [{ id: '1' }], total: 1 } });
  });

  it('forwards paging/search/sort query params to findAll', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?page=2&limit=50&search=acme&sortBy=email&sortOrder=asc');
    expect(mockFindAll).toHaveBeenCalledWith(ENV, expect.objectContaining({
      table: 'users', primaryKey: 'id', page: 2, limit: 50,
      search: 'acme', sortBy: 'email', sortOrder: 'asc',
    }));
  });

  it('defaults page/limit when omitted', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll).toHaveBeenCalledWith(ENV, expect.objectContaining({ page: 1, limit: 25 }));
  });
});

describe('GET /users/:id', () => {
  it('returns the row when found', async () => {
    mockFindById.mockResolvedValue({ id: '9' });
    const res = await req('/9');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { id: '9' } });
  });

  it('404 when not found', async () => {
    mockFindById.mockResolvedValue(null);
    const res = await req('/nope');
    expect(res.status).toBe(404);
  });
});

describe('POST /users', () => {
  it('400 when email is missing (no auth account can be created)', async () => {
    const res = await req('/', json('POST', { first_name: 'A' }));
    expect(res.status).toBe(400);
    expect(mockCreateAuthUser).not.toHaveBeenCalled();
  });

  it('creates the auth user first, then the profile row with its id, and returns 201', async () => {
    mockCreate.mockResolvedValue({ id: 'auth-new', first_name: 'A' });
    const res = await req('/', json('POST', { first_name: 'A', email: 'a@x.com' }));
    expect(mockCreateAuthUser).toHaveBeenCalledWith(ENV, 'a@x.com');
    expect(mockCreate).toHaveBeenCalledWith(ENV, 'users',
      expect.objectContaining({ email: 'a@x.com', id: 'auth-new' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { id: 'auth-new', first_name: 'A' } });
  });

  it('502 with the Admin API message when auth account creation fails', async () => {
    mockCreateAuthUser.mockRejectedValue(new Error('User already registered'));
    const res = await req('/', json('POST', { email: 'dupe@x.com' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, message: 'User already registered' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rolls back the auth user when the profile insert fails', async () => {
    mockCreate.mockRejectedValue(new Error('db exploded'));
    const res = await req('/', json('POST', { email: 'a@x.com' }));
    expect(res.status).toBe(500);
    expect(mockDeleteAuthUser).toHaveBeenCalledWith(ENV, 'auth-new');
  });

  it('normalizes an empty qb_sales_rep_id to null before insert', async () => {
    mockCreate.mockResolvedValue({ id: 'new' });
    await req('/', json('POST', { first_name: 'A', email: 'a@x.com', qb_sales_rep_id: '' }));
    expect(mockCreate).toHaveBeenCalledWith(ENV, 'users',
      expect.objectContaining({ qb_sales_rep_id: null }));
  });

  it('leaves a real qb_sales_rep_id untouched', async () => {
    mockCreate.mockResolvedValue({ id: 'new' });
    await req('/', json('POST', { email: 'a@x.com', qb_sales_rep_id: 42 }));
    expect(mockCreate).toHaveBeenCalledWith(ENV, 'users',
      expect.objectContaining({ qb_sales_rep_id: 42 }));
  });
});

describe('PUT /users/:id', () => {
  it('updates and returns the row', async () => {
    mockUpdate.mockResolvedValue({ id: '9', first_name: 'B' });
    const res = await req('/9', json('PUT', { first_name: 'B' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { id: '9', first_name: 'B' } });
  });

  it('404 when the row is missing or nothing changed', async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await req('/9', json('PUT', { first_name: 'B' }));
    expect(res.status).toBe(404);
  });

  it('normalizes qb_sales_rep_id on update too', async () => {
    mockUpdate.mockResolvedValue({ id: '9' });
    await req('/9', json('PUT', { qb_sales_rep_id: '' }));
    expect(mockUpdate).toHaveBeenCalledWith(ENV, 'users', 'id', '9',
      expect.objectContaining({ qb_sales_rep_id: null }),
      { touchUpdatedAt: false });
  });
});

describe('DELETE /users/:id', () => {
  it('deletes and returns the removed row', async () => {
    mockRemove.mockResolvedValue({ id: '9' });
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { id: '9' } });
  });

  it('404 when nothing was deleted', async () => {
    mockRemove.mockResolvedValue(null);
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
