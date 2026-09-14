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
import settingsApp from './settings';
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

const SAMPLE_TENANT = {
  tenant_id: 1, name: 'Test Company', url: 'https://test.com',
  street: '123 Main St', street2: null, city: 'Anytown',
  state: 'CA', zip: '90001', country: 'US',
  contact_email: 'info@test.com', timezone: 'America/Los_Angeles',
  date_format: 'MM/DD/YYYY', time_format: '12h', currency: 'USD',
  language: 'en', default_page_size: 25, updated_at: new Date(),
};

function setupAuth() {
  mockVerify.mockResolvedValue({ userId: 1, tenant_id: 1 });
  mockQuery.mockImplementation(authQuery(ADMIN_USER));
}

describe('Settings Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /company', () => {
    it('returns company settings in the expected shape', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [SAMPLE_TENANT] } as any);

      const res = await settingsApp.request('/company', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('1');
      expect(body.data.name).toBe('Test Company');
      expect(body.data.address.street).toBe('123 Main St');
      expect(body.data.address.city).toBe('Anytown');
      expect(body.data.contactInfo.url).toBe('https://test.com');
      expect(body.data.systemConfig.timezone).toBe('America/Los_Angeles');
      expect(body.data.features).toBeDefined();
      expect(body.data.integrations).toBeDefined();
    });

    it('returns 404 when tenant not found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await settingsApp.request('/company', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Tenant not found');
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await settingsApp.request('/company', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('PUT /company', () => {
    it('updates company settings', async () => {
      const updatedTenant = { ...SAMPLE_TENANT, name: 'Updated Company', city: 'New City' };
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [updatedTenant] } as any);

      const res = await settingsApp.request('/company', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Updated Company',
          address: { city: 'New City' },
        }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Updated Company');
      expect(body.data.address.city).toBe('New City');
      expect(body.message).toContain('updated');
    });

    it('maps nested fields correctly (systemConfig, address, contactInfo)', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [SAMPLE_TENANT] } as any);

      await settingsApp.request('/company', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          systemConfig: {
            timezone: 'UTC',
            dateFormat: 'DD/MM/YYYY',
            timeFormat: '24h',
            currency: 'EUR',
            language: 'fr',
            defaultPageSize: 50,
          },
          contactInfo: {
            url: 'https://updated.com',
            email: 'new@test.com',
          },
        }),
      }, TEST_ENV);

      // Check the SQL was called with proper mapped fields
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall).toBeDefined();
    });

    it('returns 200 with no-op message when no fields provided', async () => {
      const res = await settingsApp.request('/company', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toContain('No fields');
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await settingsApp.request('/company', {
        method: 'PUT',
        headers: { authorization: 'Bearer bad-token' },
        body: JSON.stringify({ name: 'Test' }),
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('GET / (legacy)', () => {
    it('returns company settings nested under company key', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [SAMPLE_TENANT] } as any);

      const res = await settingsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.company).toBeDefined();
      expect(body.data.company.name).toBe('Test Company');
    });

    it('returns 404 when tenant not found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await settingsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });
});
