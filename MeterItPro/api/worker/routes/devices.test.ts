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
  };
});

vi.mock('../errorHandler', () => ({
  logError: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache } from '../middleware';
import { findAll, findById } from '../crud';
import devicesApp from './devices';
import type { Env } from '../db';
import { authQuery } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const mockFindAll = vi.mocked(findAll);
const mockFindById = vi.mocked(findById);

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

describe('Devices Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    setupAuth();
  });

  describe('GET /', () => {
    it('returns paginated list of devices', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [
          { device_id: 1, description: 'BACnet Device 1', active: true },
          { device_id: 2, description: 'BACnet Device 2', active: true },
        ],
        pagination: { total: 2, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await devicesApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });

    it('passes search and sort parameters to findAll', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [],
        pagination: { total: 0, page: 1, pageSize: 25, totalPages: 0 },
      });

      await devicesApp.request('/?search=BACnet&sortBy=description&sortOrder=DESC', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(mockFindAll).toHaveBeenCalledWith(
        TEST_ENV,
        expect.objectContaining({
          table: 'device',
          primaryKey: 'device_id',
          search: 'BACnet',
          sortBy: 'description',
          sortOrder: 'DESC',
        })
      );
    });

    it('returns empty list when no devices exist', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [],
        pagination: { total: 0, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await devicesApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.items).toHaveLength(0);
      expect(body.data.total).toBe(0);
    });
  });

  describe('GET /:id', () => {
    it('returns a device by ID', async () => {
      mockFindById.mockResolvedValueOnce({
        device_id: 1, description: 'BACnet Controller', active: true, tenant_id: 1,
      });

      const res = await devicesApp.request('/1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.device_id).toBe(1);
      expect(body.data.description).toBe('BACnet Controller');
    });

    it('returns 404 when device not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await devicesApp.request('/999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Device not found');
    });

    it('uses tenantId scoping when looking up device', async () => {
      mockFindById.mockResolvedValueOnce({ device_id: 5, description: 'Test Device' });

      await devicesApp.request('/5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(mockFindById).toHaveBeenCalledWith(
        TEST_ENV, 'device', 'device_id', '5', 1
      );
    });
  });
});
