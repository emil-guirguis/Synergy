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

vi.mock('../meterQueryHelpers', () => ({
  queryConsumption: vi.fn(),
  queryDemand: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import { queryConsumption, queryDemand } from '../meterQueryHelpers';
import meterReadingsApp from './meterReadings';
import type { Env } from '../db';
import { authQuery, queueAuth } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const mockQueryConsumption = vi.mocked(queryConsumption);
const mockQueryDemand = vi.mocked(queryDemand);

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

describe('MeterReadings Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  describe('GET /', () => {
    it('returns paginated list of meter readings', async () => {
      const readings = [
        { meter_reading_id: 1, meter_id: 10, kwh: 100, created_at: '2024-01-01' },
        { meter_reading_id: 2, meter_id: 10, kwh: 110, created_at: '2024-01-02' },
      ];
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ count: '2' }] } as any) // count
        .mockResolvedValueOnce({ rows: readings } as any); // data

      const res = await meterReadingsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
      expect(body.data.page).toBe(1);
    });

    it('filters by meterId when provided', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ count: '1' }] } as any)
        .mockResolvedValueOnce({ rows: [{ meter_reading_id: 1, meter_id: 5 }] } as any);

      const res = await meterReadingsApp.request('/?meterId=5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.items).toHaveLength(1);
    });

    it('supports pagination parameters', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ count: '50' }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await meterReadingsApp.request('/?page=3&pageSize=10', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.page).toBe(3);
      expect(body.data.pageSize).toBe(10);
      expect(body.data.totalPages).toBe(5);
    });
  });

  // ── GET /consumption ───────────────────────────────────────────────────────
  describe('GET /consumption', () => {
    it('returns consumption data when all params provided', async () => {
      const consumptionData = [{ label_key: 1, calculated_kwh: 55.5 }];
      queueAuth(mockQuery, ADMIN_USER);
      mockQueryConsumption.mockResolvedValueOnce(consumptionData);

      const res = await meterReadingsApp.request(
        '/consumption?meterId=1&meterElementId=2&startDate=2024-01-01&endDate=2024-01-31',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual(consumptionData);
    });

    it('returns 400 when required params are missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request('/consumption?meterId=1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('required');
    });

    it('returns 400 when meterId is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request(
        '/consumption?meterElementId=2&startDate=2024-01-01&endDate=2024-01-31',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(400);
    });
  });

  // ── GET /demand ────────────────────────────────────────────────────────────
  describe('GET /demand', () => {
    it('returns demand data when all params provided', async () => {
      const demandData = [{ label_key: 10, power: 12.3 }];
      queueAuth(mockQuery, ADMIN_USER);
      mockQueryDemand.mockResolvedValueOnce(demandData);

      const res = await meterReadingsApp.request(
        '/demand?meterId=1&meterElementId=2&startDate=2024-01-01&endDate=2024-01-31',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual(demandData);
    });

    it('returns 400 when endDate is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request(
        '/demand?meterId=1&meterElementId=2&startDate=2024-01-01',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(400);
    });
  });

  // ── GET /virtual-consumption ───────────────────────────────────────────────
  describe('GET /virtual-consumption', () => {
    it('returns aggregated virtual consumption data', async () => {
      const rows = [{ label_key: 1, calculated_kwh: 200 }];
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows } as any);

      const res = await meterReadingsApp.request(
        '/virtual-consumption?meterId=5&startDate=2024-01-01&endDate=2024-01-31',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual(rows);
    });

    it('returns 400 when meterId is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request(
        '/virtual-consumption?startDate=2024-01-01&endDate=2024-01-31',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(400);
    });

    it('handles excludeIds parameter', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await meterReadingsApp.request(
        '/virtual-consumption?meterId=5&startDate=2024-01-01&endDate=2024-01-31&excludeIds=10,11',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(200);
    });

    it('handles overrides parameter', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await meterReadingsApp.request(
        '/virtual-consumption?meterId=5&startDate=2024-01-01&endDate=2024-01-31&overrides=10:-,11:+',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(200);
    });
  });

  // ── GET /virtual-demand ────────────────────────────────────────────────────
  describe('GET /virtual-demand', () => {
    it('returns aggregated virtual demand data', async () => {
      const rows = [{ label_key: 1, power: 50 }];
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows } as any);

      const res = await meterReadingsApp.request(
        '/virtual-demand?meterId=5&startDate=2024-01-01&endDate=2024-01-31',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual(rows);
    });

    it('returns 400 when startDate is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request(
        '/virtual-demand?meterId=5&endDate=2024-01-31',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(400);
    });
  });

  // ── GET /last ──────────────────────────────────────────────────────────────
  describe('GET /last', () => {
    it('returns last reading for a meter element', async () => {
      const reading = { meter_reading_id: 42, meter_id: 1, meter_element_id: 2, kwh: 999, serial_number: 'SN001' };
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [reading] } as any);

      const res = await meterReadingsApp.request(
        '/last?meterId=1&meterElementId=2',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.meter_reading_id).toBe(42);
    });

    it('returns 404 when no readings found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await meterReadingsApp.request(
        '/last?meterId=1&meterElementId=999',
        { headers: { authorization: 'Bearer valid-token' } },
        TEST_ENV
      );

      expect(res.status).toBe(404);
    });

    it('returns 400 when meterId is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request('/last?meterElementId=2', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('returns 400 when meterElementId is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request('/last?meterId=1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  // ── GET /virtual-last ──────────────────────────────────────────────────────
  describe('GET /virtual-last', () => {
    it('returns summed latest readings for a virtual meter', async () => {
      const row = { meter_id: 5, meter_name: 'Virtual A', total_kwh: 350, last_reading_date: '2024-01-31' };
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [row] } as any);

      const res = await meterReadingsApp.request('/virtual-last?meterId=5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.meter_id).toBe(5);
      expect(body.data.total_kwh).toBe(350);
    });

    it('returns 404 when virtual meter not found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await meterReadingsApp.request('/virtual-last?meterId=999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns 400 when meterId is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request('/virtual-last', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  // ── GET /virtual-components-last ──────────────────────────────────────────
  describe('GET /virtual-components-last', () => {
    it('returns per-component latest readings', async () => {
      const rows = [
        { select_meter_element_id: 10, operation: '+', kwh: 100 },
        { select_meter_element_id: 11, operation: '-', kwh: -30 },
      ];
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows } as any);

      const res = await meterReadingsApp.request('/virtual-components-last?meterId=5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('returns empty array when no components configured', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await meterReadingsApp.request('/virtual-components-last?meterId=5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(0);
    });

    it('returns 400 when meterId is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER);

      const res = await meterReadingsApp.request('/virtual-components-last', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });
});
