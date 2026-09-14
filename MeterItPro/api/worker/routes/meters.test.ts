/**
 * Tests for meters routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db module
vi.mock('../db', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    execQuery: vi.fn((env: any, sql: string, params?: any[]) => queryFn(env, sql, params)),
    transaction: vi.fn(),
  };
});

// Mock hono/jwt
vi.mock('hono/jwt', () => ({
  verify: vi.fn(),
}));

// Mock crud module
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
import { findAll, findById, create, update, remove } from '../crud';
import metersApp from './meters';
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

describe('Meters Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /', () => {
    it('should list meters with pagination', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [
          { meter_id: 1, name: 'Meter A', serial_number: 'SN001' },
          { meter_id: 2, name: 'Meter B', serial_number: 'SN002' },
        ],
        pagination: { total: 2, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await metersApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });

    it('should pass query parameters to findAll', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [],
        pagination: { total: 0, page: 2, pageSize: 10, totalPages: 0 },
      });

      await metersApp.request('/?page=2&limit=10&search=test&sortBy=name&sortOrder=ASC', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(mockFindAll).toHaveBeenCalledWith(
        TEST_ENV,
        expect.objectContaining({
          table: 'meter',
          primaryKey: 'meter_id',
          page: 2,
          limit: 10,
          search: 'test',
          sortBy: 'name',
          sortOrder: 'ASC',
        })
      );
    });
  });

  describe('GET /:id', () => {
    it('should return a meter by ID', async () => {
      mockFindById.mockResolvedValueOnce({
        meter_id: 1, name: 'Test Meter', serial_number: 'SN001', tenant_id: 1,
      });

      const res = await metersApp.request('/1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Test Meter');
    });

    it('should return 404 when meter not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await metersApp.request('/999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Meter not found');
    });
  });

  describe('POST /', () => {
    it('should create a new meter', async () => {
      mockCreate.mockResolvedValueOnce({
        meter_id: 10, name: 'New Meter', serial_number: 'SN100', tenant_id: 1,
      });

      const res = await metersApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Meter', serial_number: 'SN100' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.meter_id).toBe(10);
    });

    it('should convert is_virtual string to boolean', async () => {
      mockCreate.mockResolvedValueOnce({
        meter_id: 11, name: 'Virtual Meter', is_virtual: true, tenant_id: 1,
      });

      await metersApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Virtual Meter', is_virtual: 'virtual' }),
      }, TEST_ENV);

      expect(mockCreate).toHaveBeenCalledWith(
        TEST_ENV,
        'meter',
        expect.objectContaining({ is_virtual: true })
      );
    });

    it('should remove elements field from create data', async () => {
      mockCreate.mockResolvedValueOnce({
        meter_id: 12, name: 'Test', tenant_id: 1,
      });

      await metersApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Test', elements: [{ id: 1 }] }),
      }, TEST_ENV);

      expect(mockCreate).toHaveBeenCalledWith(
        TEST_ENV,
        'meter',
        expect.not.objectContaining({ elements: expect.anything() })
      );
    });
  });

  describe('PUT /:id', () => {
    it('should update a meter', async () => {
      mockFindById.mockResolvedValueOnce({ meter_id: 1, name: 'Old Name', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ meter_id: 1, name: 'New Name', tenant_id: 1 });

      const res = await metersApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Name' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('New Name');
    });

    it('should return 404 when updating non-existent meter', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await metersApp.request('/999', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Name' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('should strip read-only fields from update data', async () => {
      mockFindById.mockResolvedValueOnce({ meter_id: 1, name: 'Test', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ meter_id: 1, name: 'Updated', tenant_id: 1 });

      await metersApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Updated',
          tenant_id: 99,
          device: { id: 1 },
          status: 'active',
          elements: [],
        }),
      }, TEST_ENV);

      expect(mockUpdate).toHaveBeenCalledWith(
        TEST_ENV,
        'meter',
        'meter_id',
        '1',
        expect.not.objectContaining({
          tenant_id: expect.anything(),
          device: expect.anything(),
          status: expect.anything(),
          elements: expect.anything(),
        })
      );
    });
  });

  describe('DELETE /:id', () => {
    it('should delete a meter', async () => {
      mockFindById.mockResolvedValueOnce({ meter_id: 1, name: 'Test', tenant_id: 1 });
      mockRemove.mockResolvedValueOnce({ meter_id: 1 });

      const res = await metersApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 404 when deleting non-existent meter', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await metersApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /:meterId/virtual-config', () => {
    it('should return selected items for a virtual meter', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ meter_id: 5 }] } as any) // meter check
        .mockResolvedValueOnce({
          rows: [
            {
              selected_meter_id: 10,
              select_meter_element_id: null,
              operation: '+',
              meter_name: 'Meter A',
              identifier: 'SN010',
              meter_element_id: null,
              element_name: null,
              element: null,
            },
            {
              selected_meter_id: 11,
              select_meter_element_id: 201,
              operation: '-',
              meter_name: 'Meter B',
              identifier: 'SN011',
              meter_element_id: 201,
              element_name: 'kWh Import',
              element: 'kWh',
            },
          ],
        } as any);

      const res = await metersApp.request('/5/virtual-config', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.meterId).toBe('5');
      expect(body.selectedItems).toHaveLength(2);
      expect(body.selectedItems[0]).toMatchObject({
        selectionType: 'meter',
        meter_id: 10,
        meter_name: 'Meter A',
        operation: '+',
      });
      expect(body.selectedItems[1]).toMatchObject({
        selectionType: 'element',
        meter_id: 11,
        meter_element_id: 201,
        element_name: 'kWh Import',
        operation: '-',
      });
    });

    it('should return empty selectedItems when no config saved', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ meter_id: 5 }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await metersApp.request('/5/virtual-config', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.selectedItems).toHaveLength(0);
    });

    it('should return 404 when meter does not exist', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any); // meter not found

      const res = await metersApp.request('/999/virtual-config', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Meter not found');
    });

    it('should default operation to + when null', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ meter_id: 5 }] } as any)
        .mockResolvedValueOnce({
          rows: [{
            selected_meter_id: 10, select_meter_element_id: null, operation: null,
            meter_name: 'Meter A', identifier: 'SN010',
            meter_element_id: null, element_name: null, element: null,
          }],
        } as any);

      const res = await metersApp.request('/5/virtual-config', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      const body = await res.json();
      expect(body.selectedItems[0].operation).toBe('+');
    });
  });

  describe('POST /:meterId/virtual-config', () => {
    const mockTransaction = vi.fn();

    it('should save virtual meter configuration', async () => {
      const { transaction } = await import('../db');
      const mockTxn = vi.mocked(transaction);
      mockTxn.mockImplementationOnce(async (_env, fn) => {
        const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
        await fn(client as any);
      });

      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ meter_id: 5 }] } as any);

      const res = await metersApp.request('/5/virtual-config', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          selectedMeterIds: [10, 11],
          selectedMeterElementIds: [10, 201],
          operations: ['+', '-'],
        }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.meterId).toBe('5');
      expect(body.savedConfiguration.selectedMeterIds).toEqual([10, 11]);
    });

    it('should return 404 when meter does not exist', async () => {
      const { transaction } = await import('../db');
      vi.mocked(transaction).mockImplementation(async (_env, fn) => {
        const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
        await fn(client as any);
      });

      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await metersApp.request('/999/virtual-config', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ selectedMeterIds: [], selectedMeterElementIds: [] }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('should return 400 when arrays have mismatched lengths', async () => {
      queueAuth(mockQuery, ADMIN_USER)

      const res = await metersApp.request('/5/virtual-config', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          selectedMeterIds: [10, 11],
          selectedMeterElementIds: [10],
        }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('same length');
    });

    it('should clear existing config when saving empty selection', async () => {
      const { transaction } = await import('../db');
      const clientQueryMock = vi.fn().mockResolvedValue({ rows: [] });
      vi.mocked(transaction).mockImplementationOnce(async (_env, fn) => {
        await fn({ query: clientQueryMock } as any);
      });

      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ meter_id: 5 }] } as any);

      const res = await metersApp.request('/5/virtual-config', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ selectedMeterIds: [], selectedMeterElementIds: [] }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(clientQueryMock).toHaveBeenCalledWith(
        'DELETE FROM public.meter_virtual WHERE meter_id = $1',
        ['5']
      );
      // No INSERT when empty
      expect(clientQueryMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /elements', () => {
    it('should return meter elements for selection', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [
            { id: 1, name: 'Meter A', identifier: 'SN001' },
            { id: 2, name: 'Meter B', identifier: 'SN002' },
          ],
        } as any);

      const res = await metersApp.request('/elements', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });
  });
});
