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

vi.mock('../errorHandler', () => ({
  logError: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import { findAll, findById, create, update, remove } from '../crud';
import contactsApp from './contacts';
import type { Env } from '../db';
import { authQuery, queueAuth } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const mockFindAll = vi.mocked(findAll);
const mockFindById = vi.mocked(findById);
const mockCreate = vi.mocked(create);
const mockUpdate = vi.mocked(update);
const mockRemove = vi.mocked(remove);

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

describe('Contacts Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /stats/overview', () => {
    it('returns contact statistics and top industries', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [{
            totalContacts: '10',
            customers: '6',
            vendors: '4',
            activeContacts: '8',
            inactiveContacts: '2',
          }],
        } as any)
        .mockResolvedValueOnce({
          rows: [
            { _id: 'Energy', count: '5' },
            { _id: 'Manufacturing', count: '3' },
          ],
        } as any);

      const res = await contactsApp.request('/stats/overview', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.overview.totalContacts).toBe(10);
      expect(body.data.overview.customers).toBe(6);
      expect(body.data.overview.activeContacts).toBe(8);
      expect(body.data.topIndustries).toHaveLength(2);
    });

    it('returns zeros when no contacts exist', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await contactsApp.request('/stats/overview', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.overview.totalContacts).toBe(0);
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await contactsApp.request('/stats/overview', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('GET /', () => {
    it('returns paginated list of contacts', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [
          { contact_id: 1, name: 'Alice Corp', email: 'alice@example.com', active: true },
          { contact_id: 2, name: 'Bob Ltd', email: 'bob@example.com', active: true },
        ],
        pagination: { total: 2, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await contactsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });

    it('passes search and filter params to findAll', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [],
        pagination: { total: 0, page: 1, pageSize: 25, totalPages: 0 },
      });

      await contactsApp.request('/?search=alice&active=true&sortBy=name&sortOrder=ASC', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(mockFindAll).toHaveBeenCalledWith(
        TEST_ENV,
        expect.objectContaining({
          table: 'contact',
          primaryKey: 'contact_id',
          search: 'alice',
          sortBy: 'name',
          sortOrder: 'ASC',
          where: expect.objectContaining({ active: true }),
        })
      );
    });

    it('returns empty list when no contacts match', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [],
        pagination: { total: 0, page: 1, pageSize: 25, totalPages: 0 },
      });

      const res = await contactsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.items).toHaveLength(0);
      expect(body.data.total).toBe(0);
    });
  });

  describe('GET /:id', () => {
    it('returns a single contact by ID', async () => {
      mockFindById.mockResolvedValueOnce({
        contact_id: 1, name: 'Alice Corp', email: 'alice@example.com', tenant_id: 1,
      });

      const res = await contactsApp.request('/1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.contact_id).toBe(1);
      expect(body.data.name).toBe('Alice Corp');
    });

    it('returns 404 when contact not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await contactsApp.request('/999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Contact not found');
    });

    it('scopes lookup by tenantId', async () => {
      mockFindById.mockResolvedValueOnce({ contact_id: 5, name: 'Test Contact' });

      await contactsApp.request('/5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(mockFindById).toHaveBeenCalledWith(TEST_ENV, 'contact', 'contact_id', '5', 1);
    });
  });

  describe('POST /', () => {
    it('creates a contact and returns 201', async () => {
      mockCreate.mockResolvedValueOnce({
        contact_id: 10, name: 'New Contact', email: 'new@example.com', tenant_id: 1,
      });

      const res = await contactsApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Contact', email: 'new@example.com' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.contact_id).toBe(10);
    });

    it('injects tenant_id into create data', async () => {
      mockCreate.mockResolvedValueOnce({ contact_id: 11, name: 'Test', tenant_id: 1 });

      await contactsApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Test', email: 'test@example.com' }),
      }, TEST_ENV);

      expect(mockCreate).toHaveBeenCalledWith(
        TEST_ENV,
        'contact',
        expect.objectContaining({ tenant_id: 1 })
      );
    });
  });

  describe('PUT /:id', () => {
    it('updates a contact', async () => {
      mockFindById.mockResolvedValueOnce({ contact_id: 1, name: 'Old', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ contact_id: 1, name: 'Updated', tenant_id: 1 });

      const res = await contactsApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Updated');
    });

    it('returns 404 when contact not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await contactsApp.request('/999', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Contact not found');
    });

    it('returns 404 when contact belongs to different tenant (findById returns null)', async () => {
      // findById filters by tenantId in SQL — cross-tenant contact is invisible, not 403
      mockFindById.mockResolvedValueOnce(null);

      const res = await contactsApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Try' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('succeeds when JWT tenant_id is a string but DB returns numeric tenant_id (regression)', async () => {
      // JWT claims may decode tenant_id as string "1"; DB returns number 1.
      // The old JS strict-equality check (tenant_id !== tenantId) would incorrectly 403.
      mockVerify.mockResolvedValueOnce({ userId: 1, tenant_id: '1' });
      queueAuth(mockQuery, ADMIN_USER);
      mockFindById.mockResolvedValueOnce({ contact_id: 1, name: 'Test', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ contact_id: 1, name: 'Updated', tenant_id: 1 });

      const res = await contactsApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /:id', () => {
    it('deletes a contact', async () => {
      mockFindById.mockResolvedValueOnce({ contact_id: 1, name: 'Test', tenant_id: 1 });
      mockRemove.mockResolvedValueOnce(undefined as any);

      const res = await contactsApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('returns 404 when contact not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await contactsApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Contact not found');
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await contactsApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });
});
