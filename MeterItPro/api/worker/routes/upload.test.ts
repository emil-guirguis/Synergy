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

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache } from '../middleware';
import uploadApp from './upload';
import type { Env } from '../db';
import { authQuery } from '../testAuth';

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

describe('Upload Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    setupAuth();
  });

  describe('POST /image', () => {
    it('returns 501 not implemented', async () => {
      const res = await uploadApp.request('/image', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'multipart/form-data',
        },
        body: 'fake-file-data',
      }, TEST_ENV);

      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('not yet supported');
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await uploadApp.request('/image', {
        method: 'POST',
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /image/:filename', () => {
    it('returns 501 not implemented', async () => {
      const res = await uploadApp.request('/image/test.jpg', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('not yet supported');
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await uploadApp.request('/image/test.jpg', {
        method: 'DELETE',
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });

    it('accepts any filename in the path', async () => {
      const res = await uploadApp.request('/image/some-image-file.png', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(501);
    });
  });
});
