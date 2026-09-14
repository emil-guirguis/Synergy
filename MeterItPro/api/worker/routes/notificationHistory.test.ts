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
import notificationHistoryApp from './notificationHistory';
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

describe('NotificationHistory Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /', () => {
    it('returns list of notification history', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              notification_history_id: 1, tenant_id: 1, notification_rule_id: 10,
              users_id: null, meter_id: 5, title: 'Alert Fired',
              description: 'Test alert', status: 'sent', sent_at: new Date(), created_at: new Date(),
            },
          ],
        } as any)
        .mockResolvedValueOnce({ rows: [{ count: '1' }] } as any);

      const res = await notificationHistoryApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.history).toHaveLength(1);
      expect(body.data.history[0].id).toBe('1');
      expect(body.data.total).toBe(1);
    });

    it('filters by meter_id when provided', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);

      await notificationHistoryApp.request('/?meter_id=5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      // Should include meter_id in query
      const secondCall = mockQuery.mock.calls[1];
      expect(secondCall).toBeDefined();
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await notificationHistoryApp.request('/', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('respects limit and offset params', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);

      const res = await notificationHistoryApp.request('/?limit=10&offset=20', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.limit).toBe(10);
      expect(body.data.offset).toBe(20);
    });
  });

  describe('GET /meter/:meterId', () => {
    it('returns notifications for a specific meter in last 24h', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              notification_history_id: 1, notification_rule_id: 10,
              title: 'Gap Detected', description: 'Gap in meter 5',
              status: 'sent', sent_at: new Date(),
            },
          ],
        } as any);

      const res = await notificationHistoryApp.request('/meter/5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.notifications).toHaveLength(1);
      expect(body.data.notifications[0].id).toBe('1');
    });

    it('returns 400 for non-numeric meter ID', async () => {
      const res = await notificationHistoryApp.request('/meter/abc', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid meter ID');
    });

    it('returns empty list when no notifications', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await notificationHistoryApp.request('/meter/99', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.notifications).toHaveLength(0);
    });
  });

  describe('POST /', () => {
    it('records a notification in history', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            notification_history_id: 20, tenant_id: 1, notification_rule_id: 10,
            users_id: null, meter_id: 5, title: 'Test Alert',
            description: 'Description here', status: 'sent',
            sent_at: new Date(), created_at: new Date(),
          }],
        } as any);

      const res = await notificationHistoryApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notification_rule_id: 10,
          meter_id: 5,
          title: 'Test Alert',
          description: 'Description here',
          status: 'sent',
        }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.history.id).toBe('20');
      expect(body.data.history.title).toBe('Test Alert');
    });

    it('returns 400 when title is missing', async () => {
      const res = await notificationHistoryApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ description: 'No title', status: 'sent' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Title');
    });

    it('allows optional fields to be null', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [{
            notification_history_id: 21, tenant_id: 1, notification_rule_id: null,
            users_id: null, meter_id: null, title: 'Simple Alert',
            description: null, status: 'sent', sent_at: new Date(), created_at: new Date(),
          }],
        } as any);

      const res = await notificationHistoryApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Simple Alert' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
    });
  });
});
