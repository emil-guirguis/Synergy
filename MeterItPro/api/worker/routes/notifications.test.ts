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
import { clearUserCache } from '../middleware';
import notificationsApp from './notifications';
import type { Env } from '../db';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);

const TEST_ENV: Env = {
  JWT_SECRET: 'test-secret',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@localhost/test' },
};

// authenticateToken sets user from JWT — no DB query unless requirePermission is used.
// POST / is the exception: it loads the full caller row (getCachedUser) to stamp
// created_by_name, but only once notification_type/title are both present.
function setupAuth() {
  mockVerify.mockResolvedValue({ userId: 1, tenant_id: 1 });
}

const SAMPLE_NOTIFICATION = {
  notification_id: 10,
  tenant_id: 1,
  users_id: 1,
  meter_id: 5,
  meter_element_id: 2,
  notification_type: 'threshold',
  severity: 'warning',
  title: 'High Usage Alert',
  description: 'Usage exceeded 500 kWh',
  created_at: '2024-01-15T10:00:00Z',
};

describe('Notifications Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    setupAuth();
  });

  // ── GET /count ─────────────────────────────────────────────────────────────
  describe('GET /count', () => {
    it('returns the notification count for the current user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] } as any);

      const res = await notificationsApp.request('/count', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.count).toBe(7);
    });

    it('returns 0 when there are no notifications', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);

      const res = await notificationsApp.request('/count', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.count).toBe(0);
    });
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  describe('GET /', () => {
    it('returns notifications for the current user', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [SAMPLE_NOTIFICATION] } as any) // list
        .mockResolvedValueOnce({ rows: [{ count: '1' }] } as any); // count

      const res = await notificationsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.notifications).toHaveLength(1);
      expect(body.data.notifications[0].id).toBe('10');
      expect(body.data.total).toBe(1);
    });

    it('returns empty list when no notifications exist', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);

      const res = await notificationsApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.notifications).toHaveLength(0);
      expect(body.data.total).toBe(0);
    });

    it('respects limit and offset parameters', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ count: '50' }] } as any);

      const res = await notificationsApp.request('/?limit=10&offset=20', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.limit).toBe(10);
      expect(body.data.offset).toBe(20);
    });

    it('caps limit at 200', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);

      const res = await notificationsApp.request('/?limit=999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.limit).toBe(200);
    });
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  describe('POST /', () => {
    it('creates a notification and returns 201', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ users_id: 1, name: 'Emil Guirguis', email: 'emil@example.com' }] } as any) // getCachedUser
        .mockResolvedValueOnce({ rows: [SAMPLE_NOTIFICATION] } as any); // insert

      const res = await notificationsApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          notification_type: 'threshold',
          title: 'High Usage Alert',
          meter_id: 5,
          meter_element_id: 2,
          description: 'Usage exceeded 500 kWh',
        }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.notification.id).toBe('10');
      expect(body.data.notification.title).toBe('High Usage Alert');
    });

    it('returns 400 when notification_type is missing', async () => {
      const res = await notificationsApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Missing Type' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('required');
    });

    it('returns 400 when title is missing', async () => {
      const res = await notificationsApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ notification_type: 'threshold' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('defaults severity to warning when not provided', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...SAMPLE_NOTIFICATION, severity: 'warning' }],
      } as any);

      await notificationsApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ notification_type: 'info', title: 'Test' }),
      }, TEST_ENV);

      expect(mockQuery).toHaveBeenCalledWith(
        TEST_ENV,
        expect.any(String),
        expect.arrayContaining(['warning'])
      );
    });
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  describe('DELETE /:id', () => {
    it('deletes a notification by ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const res = await notificationsApp.request('/10', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('returns 404 when notification does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const res = await notificationsApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Notification not found');
    });

    it('returns 400 for non-numeric ID', async () => {
      const res = await notificationsApp.request('/abc', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid');
    });
  });

  // ── DELETE / ───────────────────────────────────────────────────────────────
  describe('DELETE /', () => {
    it('deletes all notifications for the current user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5 } as any);

      const res = await notificationsApp.request('/', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.deleted_count).toBe(5);
    });

    it('returns 0 deleted_count when no notifications existed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const res = await notificationsApp.request('/', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deleted_count).toBe(0);
    });
  });
});
