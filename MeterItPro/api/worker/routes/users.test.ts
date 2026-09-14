import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    execQuery: vi.fn((env: any, sql: string, params?: any[]) => queryFn(env, sql, params)),
    transaction: vi.fn(),
  };
});

vi.mock('hono/jwt', () => ({
  verify: vi.fn(),
}));

vi.mock('../crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crud')>();
  return {
    ...actual,
    findAll: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    checkDeleteRestrictions: vi.fn(),
  };
});

vi.mock('bcryptjs', () => ({
  default: {
    genSalt: vi.fn(),
    hash: vi.fn(),
    compare: vi.fn(),
  },
}));

vi.mock('../errorHandler', () => ({
  logError: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import { findAll, findById, create, update, remove } from '../crud';
import bcrypt from 'bcryptjs';
import usersApp from './users';
import type { Env } from '../db';
import { authQuery, queueAuth } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const mockFindAll = vi.mocked(findAll);
const mockFindById = vi.mocked(findById);
const mockCreate = vi.mocked(create);
const mockUpdate = vi.mocked(update);
const mockRemove = vi.mocked(remove);
const mockBcrypt = vi.mocked(bcrypt);

const TEST_ENV: Env = {
  JWT_SECRET: 'test-secret',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@localhost/test' },
};

const ADMIN_USER = {
  users_id: 1, name: 'Admin', email: 'admin@test.com',
  role: 'admin', active: true, tenant_id: 1, permissions: {},
};

function setupAuth() {
  mockVerify.mockResolvedValue({ userId: 1, tenant_id: 1 });
  mockQuery.mockImplementation(authQuery(ADMIN_USER));
}

describe('Users Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  describe('GET /', () => {
    it('returns paginated list of users', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [
          { users_id: 1, name: 'Alice', email: 'alice@test.com', role: 'admin' },
          { users_id: 2, name: 'Bob', email: 'bob@test.com', role: 'Viewer' },
        ],
        pagination: { total: 2, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await usersApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });

    it('passes search and pagination to findAll', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [],
        pagination: { total: 0, page: 2, pageSize: 10, totalPages: 0 },
      });

      await usersApp.request('/?search=alice&page=2&limit=10', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(mockFindAll).toHaveBeenCalledWith(
        TEST_ENV,
        expect.objectContaining({
          table: 'users',
          primaryKey: 'users_id',
          search: 'alice',
          page: 2,
          limit: 10,
        })
      );
    });
  });

  // ── GET /:id ───────────────────────────────────────────────────────────────
  describe('GET /:id', () => {
    it('returns a user by ID', async () => {
      mockFindById.mockResolvedValueOnce({
        users_id: 2, name: 'Bob', email: 'bob@test.com', role: 'Viewer', tenant_id: 1,
      });

      const res = await usersApp.request('/2', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.users_id).toBe(2);
      expect(body.data.name).toBe('Bob');
    });

    it('returns 404 when user not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await usersApp.request('/999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('User not found');
    });
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  describe('POST /', () => {
    it('creates a user and auto-generates permissions from role', async () => {
      mockCreate.mockResolvedValueOnce({
        users_id: 10, name: 'New User', email: 'new@test.com', role: 'Viewer', tenant_id: 1,
      });

      const res = await usersApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New User', email: 'new@test.com', role: 'Viewer', password: 'Pass123!' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.users_id).toBe(10);
    });

    it('hashes the password when provided', async () => {
      mockBcrypt.genSalt.mockResolvedValueOnce('salt' as any);
      mockBcrypt.hash.mockResolvedValueOnce('hashed-password' as any);
      mockCreate.mockResolvedValueOnce({
        users_id: 11, name: 'Secured', email: 'secure@test.com', tenant_id: 1,
      });

      await usersApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Secured', email: 'secure@test.com', password: 'plaintext' }),
      }, TEST_ENV);

      expect(mockBcrypt.hash).toHaveBeenCalledWith('plaintext', 'salt');
      expect(mockCreate).toHaveBeenCalledWith(
        TEST_ENV,
        'users',
        expect.objectContaining({ passwordhash: 'hashed-password' })
      );
      expect(mockCreate).toHaveBeenCalledWith(
        TEST_ENV,
        'users',
        expect.not.objectContaining({ password: expect.anything() })
      );
    });

    it('returns 400 when no password is provided', async () => {
      const res = await usersApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'No Pass', email: 'nopass@test.com', role: 'viewer' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Password is required');
    });

    it('returns 400 when empty string password is provided', async () => {
      const res = await usersApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'No Pass', email: 'nopass@test.com', password: '' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Password is required');
    });

    it('returns 400 when invalid permissions object is provided', async () => {
      const res = await usersApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad Perms',
          email: 'bad@test.com',
          password: 'Pass123!',
          permissions: { meter: 'not-an-object' },
        }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid permissions');
    });
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  describe('PUT /:id', () => {
    it('updates a user', async () => {
      mockFindById.mockResolvedValueOnce({ users_id: 2, name: 'Bob', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ users_id: 2, name: 'Robert', tenant_id: 1 });

      const res = await usersApp.request('/2', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Robert' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Robert');
    });

    it('succeeds when JWT tenant_id is a string but DB returns numeric tenant_id (regression)', async () => {
      // JWT claims may decode tenant_id as string "1"; DB returns number 1.
      // The old JS strict-equality check (tenant_id !== tenantId) would incorrectly 403.
      mockVerify.mockResolvedValueOnce({ userId: 1, tenant_id: '1' });
      queueAuth(mockQuery, ADMIN_USER);
      mockFindById.mockResolvedValueOnce({ users_id: 2, name: 'Bob', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ users_id: 2, name: 'Robert', tenant_id: 1 });

      const res = await usersApp.request('/2', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Robert' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
    });

    it('returns 404 when updating non-existent user', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await usersApp.request('/999', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nobody' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('strips protected fields from update', async () => {
      mockFindById.mockResolvedValueOnce({ users_id: 2, name: 'Bob', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ users_id: 2, name: 'Bob', tenant_id: 1 });

      await usersApp.request('/2', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Bob',
          password: 'should-be-stripped',
          tenant_id: 99,
          passwordhash: 'should-be-stripped',
          created_at: '2020-01-01',
          last_login_at: '2024-01-01',
          failed_login_attempts: 5,
        }),
      }, TEST_ENV);

      expect(mockUpdate).toHaveBeenCalledWith(
        TEST_ENV,
        'users',
        'users_id',
        '2',
        expect.not.objectContaining({
          password: expect.anything(),
          tenant_id: expect.anything(),
          passwordhash: expect.anything(),
          created_at: expect.anything(),
          last_login_at: expect.anything(),
          failed_login_attempts: expect.anything(),
        })
      );
    });

    it('serializes permissions object to JSON string', async () => {
      mockFindById.mockResolvedValueOnce({ users_id: 2, name: 'Bob', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ users_id: 2, tenant_id: 1 });

      const permissions = { meter: { read: true, write: true } };
      await usersApp.request('/2', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bob', permissions }),
      }, TEST_ENV);

      expect(mockUpdate).toHaveBeenCalledWith(
        TEST_ENV, 'users', 'users_id', '2',
        expect.objectContaining({ permissions: JSON.stringify(permissions) })
      );
    });

    it('converts flat permissions array to nested object', async () => {
      mockFindById.mockResolvedValueOnce({ users_id: 2, name: 'Bob', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ users_id: 2, tenant_id: 1 });

      await usersApp.request('/2', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: ['meter:read', 'device:read'] }),
      }, TEST_ENV);

      expect(mockUpdate).toHaveBeenCalledWith(
        TEST_ENV, 'users', 'users_id', '2',
        expect.objectContaining({
          permissions: JSON.stringify({ meter: { read: true }, device: { read: true } }),
        })
      );
    });
  });

  // ── PUT /:id/password ──────────────────────────────────────────────────────
  describe('PUT /:id/password', () => {
    it('updates password when current password is correct (self-service)', async () => {
      mockFindById.mockResolvedValueOnce({
        users_id: 1, passwordhash: 'stored-hash', tenant_id: 1,
      });
      mockBcrypt.compare.mockResolvedValueOnce(true as any);
      mockBcrypt.genSalt.mockResolvedValueOnce('salt' as any);
      mockBcrypt.hash.mockResolvedValueOnce('new-hash' as any);
      // requirePermission queries the user from DB before the route runs
      queueAuth(mockQuery, ADMIN_USER);

      const res = await usersApp.request('/1/password', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'newPass123', currentPassword: 'oldPass' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('returns 400 when current password is incorrect', async () => {
      mockFindById.mockResolvedValueOnce({
        users_id: 1, passwordhash: 'stored-hash', tenant_id: 1,
      });
      mockBcrypt.compare.mockResolvedValueOnce(false as any);

      const res = await usersApp.request('/1/password', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'newPass123', currentPassword: 'wrongOld' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('incorrect');
    });

    it('returns 404 when user not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await usersApp.request('/999/password', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'newPass123' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  // ── POST /:id/reset-password ───────────────────────────────────────────────
  describe('POST /:id/reset-password', () => {
    it('generates a reset token for the user', async () => {
      mockFindById.mockResolvedValueOnce({
        users_id: 2, email: 'target@test.com', tenant_id: 1,
      });
      mockBcrypt.genSalt.mockResolvedValueOnce('salt' as any);
      mockBcrypt.hash.mockResolvedValueOnce('token-hash' as any);
      // requirePermission does user DB lookup, then route does 2 more queries
      queueAuth(mockQuery, ADMIN_USER)

      const res = await usersApp.request('/2/reset-password', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('Password reset token');
    });

    it('returns 404 when target user not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await usersApp.request('/999/reset-password', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns 400 when ID is not numeric', async () => {
      const res = await usersApp.request('/abc/reset-password', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  describe('DELETE /:id', () => {
    it('deletes a user', async () => {
      mockFindById.mockResolvedValueOnce({ users_id: 2, name: 'Bob', tenant_id: 1 });
      mockRemove.mockResolvedValueOnce({ users_id: 2 });

      const res = await usersApp.request('/2', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('returns 404 when deleting non-existent user', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await usersApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });
});
