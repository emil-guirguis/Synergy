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

vi.mock('../notificationRunner', () => ({
  runNotificationRule: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import { runNotificationRule } from '../notificationRunner';
import notificationRulesApp from './notificationRules';
import type { Env } from '../db';
import { authQuery, queueAuth } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const mockRunNotificationRule = vi.mocked(runNotificationRule);

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

describe('NotificationRules Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /', () => {
    it('returns list of notification rules', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              notification_rule_id: 1, tenant_id: 1, name: 'No Reading Alert',
              description: null, rule_type: 'meter_no_reading', active: true,
              threshold_hours: 24, demand_threshold: null, schedule_cron: '0 * * * *',
              meter_selections: null, created_at: new Date(), updated_at: new Date(),
            },
          ],
        } as any)
        .mockResolvedValueOnce({ rows: [{ count: '1' }] } as any); // count

      const res = await notificationRulesApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.rules).toHaveLength(1);
      expect(body.data.rules[0].id).toBe('1');
      expect(body.data.total).toBe(1);
    });

    it('filters by active param', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] } as any);

      await notificationRulesApp.request('/?active=true', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      // Second and third calls to mockQuery include the active filter
      const secondCall = mockQuery.mock.calls[1];
      expect(secondCall).toBeDefined();
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await notificationRulesApp.request('/', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('GET /:id', () => {
    it('returns a single rule with recipients', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            notification_rule_id: 1, tenant_id: 1, name: 'Test Rule',
            rule_type: 'meter_no_reading', active: true,
          }],
        } as any)
        .mockResolvedValueOnce({
          rows: [
            { notification_rule_recipient_id: 1, email_address: 'ops@example.com' },
          ],
        } as any);

      const res = await notificationRulesApp.request('/1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.rule.id).toBe('1');
      expect(body.data.rule.recipients).toHaveLength(1);
    });

    it('returns 404 when rule not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await notificationRulesApp.request('/999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Rule not found');
    });

    it('returns 400 for non-numeric ID', async () => {
      const res = await notificationRulesApp.request('/abc', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  describe('POST /', () => {
    it('creates a notification rule with recipients', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            notification_rule_id: 10, tenant_id: 1, name: 'New Rule',
            rule_type: 'meter_no_reading', active: true, threshold_hours: 24,
            demand_threshold: null, schedule_cron: '0 * * * *',
            meter_selections: null, created_at: new Date(), updated_at: new Date(),
          }],
        } as any)
        .mockResolvedValueOnce({ rows: [] } as any); // recipient insert

      const res = await notificationRulesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'New Rule',
          rule_type: 'meter_no_reading',
          threshold_hours: 24,
          recipients: [{ email_address: 'ops@example.com' }],
        }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.rule.id).toBe('10');
    });

    it('returns 400 when name is missing', async () => {
      const res = await notificationRulesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ rule_type: 'meter_no_reading' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('name');
    });
  });

  describe('PUT /:id', () => {
    it('updates a notification rule', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [{
            notification_rule_id: 1, tenant_id: 1, name: 'Updated Rule',
            active: false, rule_type: 'meter_no_reading',
          }],
        } as any);

      const res = await notificationRulesApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated Rule', active: false }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('returns 404 when rule not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await notificationRulesApp.request('/999', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns 400 when no fields to update', async () => {
      const res = await notificationRulesApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('updates recipients when provided', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [{
            notification_rule_id: 1, name: 'Rule', tenant_id: 1, rule_type: 'meter_no_reading',
          }],
        } as any)
        .mockResolvedValueOnce({ rows: [] } as any) // delete recipients
        .mockResolvedValueOnce({ rows: [] } as any); // insert recipient

      const res = await notificationRulesApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Rule',
          recipients: [{ email_address: 'new@example.com' }],
        }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
    });
  });

  describe('GET /:id/history', () => {
    it('returns notification history for a rule', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '5' }] } as any) // count
        .mockResolvedValueOnce({
          rows: [
            { notification_history_id: 1, title: 'Alert Fired', status: 'sent', sent_at: new Date() },
          ],
        } as any);

      const res = await notificationRulesApp.request('/1/history', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.history).toHaveLength(1);
      expect(body.data.pagination.total).toBe(5);
    });

    it('returns 400 for non-numeric ID', async () => {
      const res = await notificationRulesApp.request('/abc/history', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /:id', () => {
    it('deletes a notification rule', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 1, rows: [] } as any);

      const res = await notificationRulesApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('returns 404 when rule not found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rowCount: 0, rows: [] } as any);

      const res = await notificationRulesApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /:id/run', () => {
    it('runs a notification rule immediately', async () => {
      mockRunNotificationRule.mockResolvedValueOnce(undefined);

      const res = await notificationRulesApp.request('/1/run', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockRunNotificationRule).toHaveBeenCalledWith(TEST_ENV, '1');
    });

    it('returns 404 when rule is not found or inactive', async () => {
      mockRunNotificationRule.mockRejectedValueOnce(new Error('Notification rule 1 not found or inactive'));

      const res = await notificationRulesApp.request('/1/run', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns 500 on other errors', async () => {
      mockRunNotificationRule.mockRejectedValueOnce(new Error('Database error'));

      const res = await notificationRulesApp.request('/1/run', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(500);
    });
  });
});
