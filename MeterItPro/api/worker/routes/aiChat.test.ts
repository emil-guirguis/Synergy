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

vi.mock('openai', () => ({
  default: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache } from '../middleware';
import aiChatApp from './aiChat';
import type { Env } from '../db';
import OpenAI from 'openai';
import { authQuery } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const MockOpenAI = vi.mocked(OpenAI);

const TEST_ENV: Env & { GROQ_API_KEY: string } = {
  JWT_SECRET: 'test-secret',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@localhost/test' },
  GROQ_API_KEY: 'test-groq-key',
} as any;

const TEST_ENV_NO_GROQ: Env = {
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
    MockOpenAI.mockImplementation(class {
      chat = { completions: { create: mockCreate } };
    } as any);
    clearUserCache();
    setupAuth();
  });

  describe('POST /', () => {
    it('returns 503 when GROQ_API_KEY is not configured', async () => {
      const res = await aiChatApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'How many meters?' }),
      }, TEST_ENV_NO_GROQ);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('GROQ_API_KEY');
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
        choices: [{
          message: {
            role: 'assistant',
            content: 'You have 5 active meters.',
            tool_calls: null,
          },
        }],
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
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'list_meters', arguments: '{}' },
              }],
            },
          }],
        })
        // Second call: model gives final answer after tool result
        .mockResolvedValueOnce({
          choices: [{
            message: {
              role: 'assistant',
              content: 'You have 3 meters.',
              tool_calls: null,
            },
          }],
        });

      // Tool executes a DB query
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { meter_id: 1, name: 'Meter A', serial_number: 'SN001', location_name: 'Building 1', latest_kwh: 100, latest_reading_at: new Date() },
            { meter_id: 2, name: 'Meter B', serial_number: 'SN002', location_name: 'Building 2', latest_kwh: 200, latest_reading_at: new Date() },
            { meter_id: 3, name: 'Meter C', serial_number: 'SN003', location_name: null, latest_kwh: null, latest_reading_at: null },
          ],
        } as any);

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
        choices: [{
          message: {
            role: 'assistant',
            content: 'As I mentioned before...',
            tool_calls: null,
          },
        }],
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
        choices: [{
          message: { role: 'assistant', content: 'OK', tool_calls: null },
        }],
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
});
