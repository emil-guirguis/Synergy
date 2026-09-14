/**
 * Tests for locations routes
 */

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

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import { findAll, findById, create, update, remove, checkDeleteRestrictions } from '../crud';
import locationsApp from './locations';
import type { Env } from '../db';
import { authQuery, queueAuth } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const mockFindAll = vi.mocked(findAll);
const mockFindById = vi.mocked(findById);
const mockCreate = vi.mocked(create);
const mockUpdate = vi.mocked(update);
const mockRemove = vi.mocked(remove);
const mockCheckDeleteRestrictions = vi.mocked(checkDeleteRestrictions);

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

describe('Locations Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /', () => {
    it('should list locations with pagination', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [{ location_id: 1, name: 'Building A' }],
        pagination: { total: 1, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await locationsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(1);
    });
  });

  describe('GET /:id', () => {
    it('should return a location by ID', async () => {
      mockFindById.mockResolvedValueOnce({
        location_id: 1, name: 'Building A', tenant_id: 1,
      });

      const res = await locationsApp.request('/1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Building A');
    });

    it('should return 404 when location not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await locationsApp.request('/999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /', () => {
    it('should create a location', async () => {
      mockCreate.mockResolvedValueOnce({
        location_id: 5, name: 'New Building', tenant_id: 1,
      });

      const res = await locationsApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Building' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.location_id).toBe(5);
    });
  });

  describe('PUT /:id', () => {
    it('should update a location', async () => {
      mockFindById.mockResolvedValueOnce({
        location_id: 1, name: 'Old Name', tenant_id: 1,
      });
      mockUpdate.mockResolvedValueOnce({
        location_id: 1, name: 'Updated Name', tenant_id: 1,
      });

      const res = await locationsApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated Name' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Name');
    });

    it('succeeds when JWT tenant_id is a string but DB returns numeric tenant_id (regression)', async () => {
      // JWT claims may decode tenant_id as string "1"; DB returns number 1.
      // The old JS strict-equality check (tenant_id !== tenantId) would incorrectly 403.
      mockVerify.mockResolvedValueOnce({ userId: 1, tenant_id: '1' });
      queueAuth(mockQuery, ADMIN_USER);
      mockFindById.mockResolvedValueOnce({ location_id: 1, name: 'Test', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ location_id: 1, name: 'Updated', tenant_id: 1 });

      const res = await locationsApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
    });

    it('should strip tenant_id from update data', async () => {
      mockFindById.mockResolvedValueOnce({
        location_id: 1, name: 'Test', tenant_id: 1,
      });
      mockUpdate.mockResolvedValueOnce({
        location_id: 1, name: 'Test', tenant_id: 1,
      });

      await locationsApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Test', tenant_id: 99, tenantId: 99 }),
      }, TEST_ENV);

      expect(mockUpdate).toHaveBeenCalledWith(
        TEST_ENV, 'location', 'location_id', '1',
        expect.not.objectContaining({ tenant_id: expect.anything() })
      );
    });
  });

  describe('DELETE /:id', () => {
    it('should delete a location with no meters', async () => {
      mockFindById.mockResolvedValueOnce({
        location_id: 1, name: 'Empty Building', tenant_id: 1,
      });
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] } as any); // meter count

      mockRemove.mockResolvedValueOnce({ location_id: 1 });

      const res = await locationsApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should prevent deleting a location with associated meters', async () => {
      mockFindById.mockResolvedValueOnce({
        location_id: 1, name: 'Busy Building', tenant_id: 1,
      });
      queueAuth(mockQuery, ADMIN_USER); // auth
      mockCheckDeleteRestrictions.mockResolvedValueOnce({
        table: 'meter',
        count: 3,
        message: 'Cannot delete — 3 meters still reference this record. Reassign or remove them first.',
      });

      const res = await locationsApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.message).toContain('3 meters');
    });

    it('should return 404 when deleting non-existent location', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await locationsApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });
});
