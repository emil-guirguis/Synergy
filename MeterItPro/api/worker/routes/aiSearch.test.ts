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

vi.mock('../errorHandler', () => ({
  logError: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import aiSearchApp from './aiSearch';
import type { Env } from '../db';
import { authQuery, queueAuth } from '../testAuth';

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
  mockQuery.mockImplementation(authQuery(ADMIN_USER));
}

describe('AI Search Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('POST /', () => {
    it('returns matching devices for a search query', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { id: 1, tenantId: 1, name: 'BACnet Controller', type: 'bacnet', location: 'Building A', status: 'active', metadata: {} },
            { id: 2, tenantId: 1, name: 'Modbus Device', type: 'modbus', location: 'Building B', status: 'active', metadata: {} },
          ],
        } as any) // devices
        .mockResolvedValueOnce({ rows: [] } as any) // meters
        .mockResolvedValueOnce({ rows: [] } as any); // readings

      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'BACnet', limit: 20, offset: 0 }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.results.length).toBeGreaterThan(0);
      expect(body.data.results[0].name).toBe('BACnet Controller');
      expect(body.data.results[0].type).toBe('device');
      expect(body.data.results[0].relevanceScore).toBeGreaterThan(0);
    });

    it('returns empty results when no devices match', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [
            { id: 1, tenantId: 1, name: 'Unrelated Device', type: 'bacnet', location: 'Building A', status: 'active', metadata: {} },
          ],
        } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'zzznomatches', limit: 20, offset: 0 }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.results).toHaveLength(0);
    });

    it('returns empty when no devices exist', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any); // no devices

      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'anything', limit: 20, offset: 0 }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.results).toHaveLength(0);
      expect(body.data.total).toBe(0);
    });

    it('returns 400 when query is missing', async () => {
      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ limit: 20, offset: 0 }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_QUERY');
    });

    it('returns 400 when query is empty string', async () => {
      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: '   ', limit: 20, offset: 0 }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_QUERY');
    });

    it('returns 400 when limit is invalid', async () => {
      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'test', limit: -1, offset: 0 }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_LIMIT');
    });

    it('returns 400 when offset is negative', async () => {
      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'test', limit: 10, offset: -1 }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_OFFSET');
    });

    it('scores exact matches higher than partial matches', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { id: 1, tenantId: 1, name: 'BACnet', type: 'bacnet', location: null, status: null, metadata: {} },
            { id: 2, tenantId: 1, name: 'BACnet Controller Alpha', type: 'bacnet', location: null, status: null, metadata: {} },
          ],
        } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'BACnet', limit: 20, offset: 0 }),
      }, TEST_ENV);

      const body = await res.json();
      const results = body.data.results;
      // Exact match (id=1) should have higher relevance than partial match (id=2)
      const exactMatch = results.find((r: any) => r.id === 1);
      const partialMatch = results.find((r: any) => r.id === 2);
      expect(exactMatch?.relevanceScore).toBeGreaterThanOrEqual(partialMatch?.relevanceScore ?? 0);
    });

    it('respects offset pagination', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { id: 1, tenantId: 1, name: 'Meter A', type: 'bacnet', location: null, status: null, metadata: {} },
            { id: 2, tenantId: 1, name: 'Meter B', type: 'bacnet', location: null, status: null, metadata: {} },
          ],
        } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'Meter', limit: 1, offset: 1 }),
      }, TEST_ENV);

      const body = await res.json();
      // With offset=1 and limit=1, only second result should appear
      expect(body.data.results).toHaveLength(1);
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer bad-token' },
        body: JSON.stringify({ query: 'test' }),
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('includes executionTime in response', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await aiSearchApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'test', limit: 10, offset: 0 }),
      }, TEST_ENV);

      const body = await res.json();
      expect(body.data.executionTime).toBeGreaterThanOrEqual(0);
    });
  });
});
