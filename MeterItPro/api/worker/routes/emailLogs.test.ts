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
import emailLogsApp from './emailLogs';
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

describe('EmailLogs Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /search', () => {
    it('returns email logs matching recipient', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '2' }] } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              report_email_logs_id: 1, report_id: 10, report_history_id: null,
              recipient: 'ops@example.com', sent_at: new Date(),
              status: 'sent', error_details: null, created_at: new Date(),
            },
            {
              report_email_logs_id: 2, report_id: 10, report_history_id: null,
              recipient: 'ops2@example.com', sent_at: new Date(),
              status: 'failed', error_details: 'SMTP error', created_at: new Date(),
            },
          ],
        } as any);

      const res = await emailLogsApp.request('/search?recipient=ops', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.emails).toHaveLength(2);
      expect(body.data.pagination.total).toBe(2);
    });

    it('returns 400 when recipient parameter is missing', async () => {
      const res = await emailLogsApp.request('/search', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Recipient');
    });

    it('returns 400 when recipient is empty string', async () => {
      const res = await emailLogsApp.request('/search?recipient=', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('respects pagination parameters', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ total: '50' }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await emailLogsApp.request('/search?recipient=test&page=2&limit=5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.pagination.page).toBe(2);
      expect(body.data.pagination.limit).toBe(5);
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await emailLogsApp.request('/search?recipient=test', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('GET /export', () => {
    it('returns JSON export when format=json', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [
            {
              report_email_logs_id: 1, report_id: 5, report_history_id: null,
              recipient: 'test@example.com', sent_at: new Date(),
              status: 'sent', error_details: null, created_at: new Date(),
            },
          ],
        } as any);

      const res = await emailLogsApp.request('/export?format=json', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.emails).toHaveLength(1);
      expect(body.data.count).toBe(1);
      expect(body.data.exportedAt).toBeDefined();
    });

    it('returns CSV export by default', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [
            {
              report_email_logs_id: 1, report_id: 5, report_history_id: null,
              recipient: 'test@example.com', sent_at: new Date(),
              status: 'sent', error_details: null, created_at: new Date(),
            },
          ],
        } as any);

      const res = await emailLogsApp.request('/export', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toContain('email-logs');
    });

    it('returns 400 for invalid format', async () => {
      const res = await emailLogsApp.request('/export?format=xml', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Format');
    });

    it('filters by reportId when provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] } as any);

      await emailLogsApp.request('/export?format=json&reportId=5', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      const firstCall = mockQuery.mock.calls[0];
      expect(firstCall).toBeDefined();
    });

    it('returns 400 for invalid startDate format', async () => {
      const res = await emailLogsApp.request('/export?format=json&startDate=not-a-date', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('startDate');
    });

    it('returns 400 for invalid endDate format', async () => {
      const res = await emailLogsApp.request('/export?format=json&endDate=bad', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });
});
