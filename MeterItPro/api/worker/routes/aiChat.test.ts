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

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import aiChatApp from './aiChat';
import type { Env } from '../db';
import Anthropic from '@anthropic-ai/sdk';
import { authQuery } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const MockAnthropic = vi.mocked(Anthropic);

const TEST_ENV: Env & { ANTHROPIC_API_KEY: string } = {
  JWT_SECRET: 'test-secret',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@localhost/test' },
  ANTHROPIC_API_KEY: 'test-anthropic-key',
} as any;

const TEST_ENV_NO_KEY: Env = {
  JWT_SECRET: 'test-secret',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@localhost/test' },
} as any;

const ADMIN_USER = {
  users_id: 1, name: 'Admin', email: 'admin@test.com',
  role: 'admin', active: true, tenant_id: 1, permissions: {},
};

let mockCreate: ReturnType<typeof vi.fn>;

function setupAuth() {
  mockVerify.mockResolvedValue({ userId: 1, tenant_id: 1 });
  mockQuery.mockImplementation(authQuery(ADMIN_USER));
}

describe('AI Chat Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCreate = vi.fn();
    MockAnthropic.mockImplementation(class {
      messages = { create: mockCreate };
    } as any);
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('POST /', () => {
    it('returns 503 when ANTHROPIC_API_KEY is not configured', async () => {
      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'How many meters?' }),
      }, TEST_ENV_NO_KEY);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('ANTHROPIC_API_KEY');
    });

    it('returns 400 when message is missing', async () => {
      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('message is required');
    });

    it('returns 400 when message is empty', async () => {
      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: '   ' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON body', async () => {
      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: 'not-json',
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('returns AI response when model replies without tool calls', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You have 5 active meters.' }],
      });

      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'How many meters do I have?' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.response).toBe('You have 5 active meters.');
      expect(body.tools_used).toEqual([]);
    });

    it('executes tool calls and returns final response', async () => {
      // First call: model requests a tool
      mockCreate
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'call_1', name: 'list_meters', input: {} },
          ],
        })
        // Second call: model gives final answer after tool result
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'You have 3 meters.' }],
        });

      // The route now also resolves the full user + permissions (getCachedUser,
      // role_permission) before the tool ever runs — layer the tool's own
      // meter query on top of the base auth routing (by SQL content) instead
      // of a bare "next call" queue, which the auth calls would consume first.
      const baseAuth = authQuery(ADMIN_USER);
      mockQuery.mockImplementation(async (env: any, sql: string, params?: any[]) => {
        if (/FROM meter m/.test(sql)) {
          return {
            rows: [
              { meter_id: 1, name: 'Meter A', serial_number: 'SN001', location_name: 'Building 1', latest_kwh: 100, latest_reading_at: new Date() },
              { meter_id: 2, name: 'Meter B', serial_number: 'SN002', location_name: 'Building 2', latest_kwh: 200, latest_reading_at: new Date() },
              { meter_id: 3, name: 'Meter C', serial_number: 'SN003', location_name: null, latest_kwh: null, latest_reading_at: null },
            ],
          } as any;
        }
        return baseAuth(env, sql, params);
      });

      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'List all my meters' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.response).toBe('You have 3 meters.');
      expect(body.tools_used).toContain('list_meters');
    });

    it('includes message history in the request', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'As I mentioned before...' }],
      });

      const history = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'Tell me more', history }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      // Verify history was included in the messages
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages.some((m: any) => m.content === 'Hello')).toBe(true);
      expect(callArgs.messages.some((m: any) => m.content === 'Hi there!')).toBe(true);
    });

    it('filters out invalid roles from history', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'OK' }],
      });

      const history = [
        { role: 'user', content: 'Valid' },
        { role: 'system', content: 'Should be filtered' }, // invalid role
        { role: 'assistant', content: 'Also valid' },
      ];

      await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'Hi', history }),
      }, TEST_ENV);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages.some((m: any) => m.content === 'Should be filtered')).toBe(false);
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer bad-token' },
        body: JSON.stringify({ message: 'test' }),
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  // This route previously had only authenticateToken — any authenticated
  // tenant user got every tool regardless of role. toolAllowed()/
  // TOOL_PERMISSION now gate each tool by the real module permission its
  // data belongs to (meter:read, notification:read, dashboard:read).
  describe('POST / — per-tool permission gating', () => {
    async function send(message = 'hi') {
      mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
      await aiChatApp.request('/', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      }, TEST_ENV);
      return mockCreate.mock.calls[0][0].tools.map((t: any) => t.name);
    }

    it('a full-access caller gets every tool', async () => {
      const names = await send();
      for (const n of ['list_meters', 'get_meter_readings', 'list_notification_rules', 'get_recent_alerts', 'get_dashboard_summary']) {
        expect(names).toContain(n);
      }
    });

    it('drops meter tools without meter:read', async () => {
      mockQuery.mockImplementation(authQuery(
        { users_id: 2, name: 'Viewer', email: 'viewer@test.com', role: 'viewer', active: true, tenant_id: 1, permissions: {}, role_id: 2 },
        [
          { permission: 'notification:read', scope: 'all', hidden_fields: [] },
          { permission: 'dashboard:read', scope: 'all', hidden_fields: [] },
        ]
      ));
      const names = await send();
      expect(names).not.toContain('list_meters');
      expect(names).not.toContain('get_meter_readings');
      expect(names).toContain('list_notification_rules');
      expect(names).toContain('get_dashboard_summary');
    });

    it('drops notification tools without notification:read', async () => {
      mockQuery.mockImplementation(authQuery(
        { users_id: 3, name: 'Viewer2', email: 'viewer2@test.com', role: 'viewer', active: true, tenant_id: 1, permissions: {}, role_id: 3 },
        [
          { permission: 'meter:read', scope: 'all', hidden_fields: [] },
          { permission: 'dashboard:read', scope: 'all', hidden_fields: [] },
        ]
      ));
      const names = await send();
      expect(names).not.toContain('list_notification_rules');
      expect(names).not.toContain('get_recent_alerts');
      expect(names).toContain('list_meters');
    });

    it('drops get_dashboard_summary without dashboard:read', async () => {
      mockQuery.mockImplementation(authQuery(
        { users_id: 4, name: 'Viewer3', email: 'viewer3@test.com', role: 'viewer', active: true, tenant_id: 1, permissions: {}, role_id: 4 },
        [{ permission: 'meter:read', scope: 'all', hidden_fields: [] }]
      ));
      const names = await send();
      expect(names).not.toContain('get_dashboard_summary');
      expect(names).toContain('list_meters');
    });

    it('a caller with no grants at all gets no tenant-data tools (memory tool aside)', async () => {
      mockQuery.mockImplementation(authQuery(
        { users_id: 5, name: 'Nobody', email: 'nobody@test.com', role: 'none', active: true, tenant_id: 1, permissions: {}, role_id: 5 },
        []
      ));
      const names = await send();
      for (const n of ['list_meters', 'get_meter_readings', 'list_notification_rules', 'get_recent_alerts', 'get_dashboard_summary']) {
        expect(names).not.toContain(n);
      }
    });
  });
});
