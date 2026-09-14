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

vi.mock('../crud', () => ({
  findAll: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../errorHandler', () => ({
  logError: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import { findAll, findById, create, update, remove } from '../crud';
import dashboardApp from './dashboard';
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

describe('Dashboard Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /cards', () => {
    it('returns list of dashboard cards', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [
          { dashboard_id: 1, card_name: 'Energy Card', grid_x: 0, grid_y: 0, grid_w: 6, grid_h: 9, meter_selections: null },
          { dashboard_id: 2, card_name: 'Power Card', grid_x: 6, grid_y: 0, grid_w: 6, grid_h: 9, meter_selections: null },
        ],
        pagination: { total: 2, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await dashboardApp.request('/cards', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });

    it('fills in default grid values when missing', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [{ dashboard_id: 1, card_name: 'Card', meter_selections: null }],
        pagination: { total: 1, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await dashboardApp.request('/cards', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      const body = await res.json();
      const card = body.data.items[0];
      expect(card.grid_x).toBe(0);
      expect(card.grid_w).toBe(500);
      expect(card.grid_h).toBe(500);
    });

    it('parses meter_selections JSON string', async () => {
      const selections = [{ meter_id: 1, register_field_names: ['kwh'] }];
      mockFindAll.mockResolvedValueOnce({
        rows: [{ dashboard_id: 1, card_name: 'Card', meter_selections: JSON.stringify(selections) }],
        pagination: { total: 1, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await dashboardApp.request('/cards', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      const body = await res.json();
      expect(body.data.items[0].meter_selections).toEqual(selections);
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await dashboardApp.request('/cards', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('GET /cards/:id', () => {
    it('returns a single dashboard card', async () => {
      mockFindById.mockResolvedValueOnce({
        dashboard_id: 1, card_name: 'Energy Card', grid_x: 0, grid_y: 0, grid_w: 6, grid_h: 9,
        meter_selections: null, tenant_id: 1,
      });

      const res = await dashboardApp.request('/cards/1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.dashboard_id).toBe(1);
      expect(body.data.card_name).toBe('Energy Card');
    });

    it('returns 404 when card not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await dashboardApp.request('/cards/999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Dashboard card not found');
    });
  });

  describe('POST /cards', () => {
    it('creates a dashboard card', async () => {
      // findAll for existing cards layout
      mockFindAll.mockResolvedValueOnce({
        rows: [],
        pagination: { total: 0, page: 1, pageSize: 25, totalPages: 1 },
      });
      mockCreate.mockResolvedValueOnce({
        dashboard_id: 10, card_name: 'New Card', tenant_id: 1,
        grid_x: 0, grid_y: 0, grid_w: 6, grid_h: 9,
      });

      const res = await dashboardApp.request('/cards', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          card_name: 'New Card',
          visualization_type: 'line',
          time_frame_type: 'last_month',
        }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.dashboard_id).toBe(10);
    });

    it('validates meter_id belongs to tenant when provided', async () => {
      // findById for meter validation - returns null (not found)
      mockFindById.mockResolvedValueOnce(null);

      const res = await dashboardApp.request('/cards', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          card_name: 'Test Card',
          meter_id: 999,
        }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /cards/:id', () => {
    it('updates a dashboard card', async () => {
      mockFindById.mockResolvedValueOnce({
        dashboard_id: 1, card_name: 'Old Name', tenant_id: 1,
      });
      mockUpdate.mockResolvedValueOnce({
        dashboard_id: 1, card_name: 'New Name', tenant_id: 1,
        grid_x: 0, grid_y: 0, grid_w: 6, grid_h: 9, meter_selections: null,
      });

      const res = await dashboardApp.request('/cards/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ card_name: 'New Name' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.card_name).toBe('New Name');
    });

    it('returns 404 when card not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await dashboardApp.request('/cards/999', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ card_name: 'New' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('serializes meter_selections array to JSON string', async () => {
      mockFindById.mockResolvedValueOnce({ dashboard_id: 1, card_name: 'Card', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({
        dashboard_id: 1, card_name: 'Card', tenant_id: 1,
        grid_x: 0, grid_y: 0, grid_w: 6, grid_h: 9,
        meter_selections: '[{"meter_id":1}]',
      });

      const selections = [{ meter_id: 1 }];
      await dashboardApp.request('/cards/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ meter_selections: selections }),
      }, TEST_ENV);

      expect(mockUpdate).toHaveBeenCalledWith(
        TEST_ENV, 'dashboard', 'dashboard_id', '1',
        expect.objectContaining({ meter_selections: JSON.stringify(selections) })
      );
    });
  });

  describe('DELETE /cards/:id', () => {
    it('deletes a dashboard card', async () => {
      mockFindById.mockResolvedValueOnce({ dashboard_id: 1, card_name: 'Card', tenant_id: 1 });
      mockRemove.mockResolvedValueOnce(undefined as any);

      const res = await dashboardApp.request('/cards/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('returns 404 when card not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await dashboardApp.request('/cards/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /meters', () => {
    it('returns list of active meters', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { id: 1, name: 'Meter A' },
            { id: 2, name: 'Meter B' },
          ],
        } as any);

      const res = await dashboardApp.request('/meters', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });
  });

  describe('GET /meters/:meterId/elements', () => {
    it('returns elements for a valid meter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ meter_id: 1, tenant_id: 1 }] } as any)
        .mockResolvedValueOnce({
          rows: [
            { meter_element_id: 1, meter_id: 1, element: 'A', name: 'Phase A' },
          ],
        } as any);

      const res = await dashboardApp.request('/meters/1/elements', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it('returns 404 when meter not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await dashboardApp.request('/meters/999/elements', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns 403 when meter belongs to different tenant', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ meter_id: 1, tenant_id: 99 }] } as any);

      const res = await dashboardApp.request('/meters/1/elements', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(403);
    });
  });

  describe('GET /power-columns', () => {
    it('returns power columns for a device', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [
            { name: 'kwh' },
            { name: 'kw' },
          ],
        } as any);

      const res = await dashboardApp.request('/power-columns?deviceId=1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.meta.count).toBe(2);
    });

    it('returns 400 when deviceId is missing', async () => {
      const res = await dashboardApp.request('/power-columns', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  describe('GET /power-columns/cache/stats', () => {
    it('returns no-cache message', async () => {
      const res = await dashboardApp.request('/power-columns/cache/stats', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.cached).toBe(false);
    });
  });
});
