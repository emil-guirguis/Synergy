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
import meterElementsApp from './meterElements';
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

// meterElements is mounted at /meters/:meterId/elements - we test the sub-app directly
// using the param meterId injected as a route param
describe('MeterElements Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /schema', () => {
    it('returns the meter element schema', async () => {
      const res = await meterElementsApp.request('/schema', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.formFields).toBeDefined();
      expect(body.data.formFields.name).toBeDefined();
      expect(body.data.formFields.element).toBeDefined();
      expect(body.data.entityFields).toBeDefined();
      expect(body.data.entityFields.meter_element_id).toBeDefined();
    });

    it('includes element enum values A-Z', async () => {
      const res = await meterElementsApp.request('/schema', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      const body = await res.json();
      expect(body.data.formFields.element.enumValues).toContain('A');
      expect(body.data.formFields.element.enumValues).toContain('Z');
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await meterElementsApp.request('/schema', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('GET /', () => {
    it('returns elements for a meter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ meter_id: 1 }] } as any)       // meter verify
        .mockResolvedValueOnce({
          rows: [
            { meter_element_id: 1, meter_id: 1, name: 'Phase A', element: 'A' },
            { meter_element_id: 2, meter_id: 1, name: 'Phase B', element: 'B' },
          ],
        } as any);

      const res = await meterElementsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('returns 404 when meter not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any); // meter not found

      const res = await meterElementsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Meter not found');
    });
  });

  describe('POST /', () => {
    it('creates a meter element', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ meter_id: 1 }] } as any)  // meter verify
        .mockResolvedValueOnce({ rows: [] } as any)                  // duplicate check
        .mockResolvedValueOnce({
          rows: [{ meter_element_id: 10, meter_id: 1, name: 'Phase A', element: 'A' }],
        } as any);

      const res = await meterElementsApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Phase A', element: 'A' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.meter_element_id).toBe(10);
      expect(body.data.element).toBe('A');
    });

    it('returns 400 when name or element is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER)

      const res = await meterElementsApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Phase A' }), // missing element
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });

    it('returns 404 when meter not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any); // meter not found

      const res = await meterElementsApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Phase A', element: 'A' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns 400 when element is duplicate', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ meter_id: 1 }] } as any)
        .mockResolvedValueOnce({ rows: [{ meter_element_id: 5 }] } as any); // duplicate exists

      const res = await meterElementsApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Phase A', element: 'A' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errors.element).toContain('already assigned');
    });
  });

  describe('PUT /:elementId', () => {
    it('updates a meter element', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ meter_id: 1 }] } as any)     // meter verify
        .mockResolvedValueOnce({ rows: [{ meter_element_id: 1, name: 'Old', element: 'A' }] } as any) // element find
        .mockResolvedValueOnce({ rows: [{ meter_element_id: 1, meter_id: 1, name: 'Updated', element: 'A' }] } as any); // update

      const res = await meterElementsApp.request('/1', {
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

    it('returns 404 when meter not found', async () => {
      // PUT/DELETE here carry no requirePermission guard, so no auth lookup
      // happens — the first queued result is the route's own meter query.
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const res = await meterElementsApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns 404 when element not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ meter_id: 1 }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any); // element not found

      const res = await meterElementsApp.request('/999', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Element not found');
    });

    it('returns 400 when no fields to update', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ meter_id: 1 }] } as any)
        .mockResolvedValueOnce({ rows: [{ meter_element_id: 1, name: 'Old', element: 'A' }] } as any);

      const res = await meterElementsApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}), // no fields
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('No fields');
    });
  });

  describe('DELETE /:elementId', () => {
    it('deletes a meter element', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ meter_id: 1 }] } as any)
        .mockResolvedValueOnce({ rows: [{ meter_element_id: 1 }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any); // delete

      const res = await meterElementsApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('returns 404 when meter not found', async () => {
      // PUT/DELETE here carry no requirePermission guard, so no auth lookup
      // happens — the first queued result is the route's own meter query.
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const res = await meterElementsApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns 404 when element not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ meter_id: 1 }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any); // element not found

      const res = await meterElementsApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Element not found');
    });
  });
});
