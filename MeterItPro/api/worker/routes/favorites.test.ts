/**
 * Tests for favorites routes
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

import { verify } from 'hono/jwt';
import { query, transaction } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import favoritesApp from './favorites';
import type { Env } from '../db';
import { queueAuth } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);

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
}

describe('Favorites Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /', () => {
    it('should return favorites for a user', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { favorite_id: 1, table_name: 'meter', id1: 10, id2: 5, favorite_name: 'Meter A (kWh)' },
            { favorite_id: 2, table_name: 'meter', id1: 20, id2: 8, favorite_name: 'Meter B (kW)' },
          ],
        } as any);

      const res = await favoritesApp.request('/?users_id=1&tenant_id=1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('should return 400 when users_id is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await favoritesApp.request('/?tenant_id=1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('users_id');
    });
  });

  describe('POST /', () => {
    it('should create a new favorite', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any) // check existing
        .mockResolvedValueOnce({ rows: [{ next_order: 1 }] } as any) // next order
        .mockResolvedValueOnce({
          rows: [{ favorite_id: 5, tenant_id: 1, users_id: 1, table_name: 'meter', id1: 10, id2: 3 }],
        } as any); // insert

      const res = await favoritesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tenant_id: 1, users_id: 1, table_name: 'meter', id1: 10, id2: 3,
        }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.favorite_id).toBe(5);
    });

    it('should return 409 when favorite already exists', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ favorite_id: 1 }] } as any); // existing

      const res = await favoritesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tenant_id: 1, users_id: 1, table_name: 'meter', id1: 10, id2: 3,
        }),
      }, TEST_ENV);

      expect(res.status).toBe(409);
    });

    it('should return 400 when required fields are missing', async () => {

      const res = await favoritesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tenant_id: 1 }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /order', () => {
    it('should update favorite order', async () => {
      const mockTransaction = vi.mocked(transaction);
      mockTransaction.mockResolvedValueOnce(undefined as any);

      const res = await favoritesApp.request('/order', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 1,
          users_id: 1,
          order: [
            { favorite_id: 1, order_by: 1 },
            { favorite_id: 2, order_by: 2 },
          ],
        }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await favoritesApp.request('/order', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ users_id: 1, order: [] }), // missing tenant_id
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('should return 400 when order is not an array', async () => {
      const res = await favoritesApp.request('/order', {
        method: 'PUT',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: 1, users_id: 1, order: 'invalid' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /:favoriteId', () => {
    it('should delete a favorite', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ favorite_id: 1, tenant_id: 1 }],
        } as any); // delete returning

      const res = await favoritesApp.request('/1?tenant_id=1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 404 when favorite not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any); // delete returns nothing

      const res = await favoritesApp.request('/999?tenant_id=1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /meters', () => {
    it('should return meters with elements and favorite status', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { meter_id: 1, meter_name: 'Meter A', meter_element_id: 10, element: 'kWh', name: 'Energy', favorite_name: '(kWh) Energy', is_favorited: true, favorite_id: 1 },
            { meter_id: 1, meter_name: 'Meter A', meter_element_id: 11, element: 'kW', name: 'Demand', favorite_name: '(kW) Demand', is_favorited: false, favorite_id: null },
          ],
        } as any);

      const res = await favoritesApp.request('/meters?users_id=1&tenant_id=1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1); // One meter with 2 elements
      expect(body.data[0].elements).toHaveLength(2);
    });
  });
});
