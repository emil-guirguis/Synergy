/**
 * Tests for emails routes
 */

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
import emailsApp from './emails';
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

describe('Emails Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  // ── Stub endpoints (all return 501) ─────────────────────────────────────────

  describe('POST /send', () => {
    it('returns 501 Not Implemented', async () => {
      const res = await emailsApp.request('/send', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'user@example.com', subject: 'Test', body: 'Hello' }),
      }, TEST_ENV);

      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });

  describe('POST /send-raw', () => {
    it('returns 501 Not Implemented', async () => {
      const res = await emailsApp.request('/send-raw', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(501);
    });
  });

  describe('POST /send-with-attachment', () => {
    it('returns 501 Not Implemented', async () => {
      const res = await emailsApp.request('/send-with-attachment', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(501);
    });
  });

  describe('POST /send-bulk', () => {
    it('returns 501 Not Implemented', async () => {
      const res = await emailsApp.request('/send-bulk', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(501);
    });
  });

  // ── GET /delivery-stats ──────────────────────────────────────────────────────

  describe('GET /delivery-stats', () => {
    it('returns email delivery statistics', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [
            { status: 'sent', count: '25' },
            { status: 'delivered', count: '20' },
            { status: 'failed', count: '5' },
          ],
        } as any);

      const res = await emailsApp.request('/delivery-stats', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(3);
      expect(body.data[0].status).toBe('sent');
    });

    it('returns 401 without authorization', async () => {
      const res = await emailsApp.request('/delivery-stats', {}, TEST_ENV);
      expect(res.status).toBe(401);
    });
  });

  // ── GET /logs ────────────────────────────────────────────────────────────────

  describe('GET /logs', () => {
    it('returns paginated email logs', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ count: '2' }] } as any)  // count
        .mockResolvedValueOnce({
          rows: [
            { email_logs_id: 1, recipient: 'a@b.com', subject: 'Test', status: 'sent' },
            { email_logs_id: 2, recipient: 'c@d.com', subject: 'Test 2', status: 'delivered' },
          ],
        } as any);

      const res = await emailsApp.request('/logs', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.pagination.totalItems).toBe(2);
    });

    it('filters logs by status', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ count: '1' }] } as any)
        .mockResolvedValueOnce({
          rows: [{ email_logs_id: 1, recipient: 'a@b.com', status: 'failed' }],
        } as any);

      const res = await emailsApp.request('/logs?status=failed', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  // ── GET /track/open/:trackingId ──────────────────────────────────────────────

  describe('GET /track/open/:trackingId', () => {
    it('returns a 1x1 tracking pixel and records the open', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any); // UPDATE email_logs

      const res = await emailsApp.request('/track/open/abc123', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
    });
  });

  // ── POST /notifications/trigger ──────────────────────────────────────────────

  describe('POST /notifications/trigger', () => {
    it('returns 501 Not Implemented', async () => {
      const res = await emailsApp.request('/notifications/trigger', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(501);
    });
  });

  // ── GET /notifications/status ────────────────────────────────────────────────

  describe('GET /notifications/status', () => {
    it('returns 501 Not Implemented', async () => {
      const res = await emailsApp.request('/notifications/status', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(501);
    });
  });
});
