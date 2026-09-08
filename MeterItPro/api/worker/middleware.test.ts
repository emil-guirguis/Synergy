/**
 * Tests for authentication and permission middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module
vi.mock('./db', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    execQuery: vi.fn((env: any, sql: string, params?: any[]) => queryFn(env, sql, params)),
    transaction: vi.fn(),
  };
});

// Mock hono/jwt
vi.mock('hono/jwt', () => ({
  verify: vi.fn(),
  sign: vi.fn(),
}));

import { Hono } from 'hono';
import { verify } from 'hono/jwt';
import { query } from './db';
import { authenticateToken, requirePermission, authenticateSyncServer, clearUserCache, clearSyncTenantCache } from './middleware';
import type { Env } from './db';
import type { AuthVariables } from './middleware';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);

function createApp() {
  return new Hono<{ Bindings: Env; Variables: AuthVariables }>();
}

const TEST_ENV: Env = {
  JWT_SECRET: 'test-secret-key',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@localhost/test' },
};

describe('authenticateToken middleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
  });

  it('should return 401 when no authorization header is provided', async () => {
    const app = createApp();
    app.use('*', authenticateToken);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {}, TEST_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Access token required');
  });

  it('should return 401 when token is invalid', async () => {
    mockVerify.mockRejectedValueOnce(new Error('Invalid'));

    const app = createApp();
    app.use('*', authenticateToken);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { authorization: 'Bearer invalid-token' },
    }, TEST_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Invalid token');
  });

  it('should return 401 when token is expired', async () => {
    const error = new Error('Token expired');
    error.name = 'JwtTokenExpired';
    mockVerify.mockRejectedValueOnce(error);

    const app = createApp();
    app.use('*', authenticateToken);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { authorization: 'Bearer expired-token' },
    }, TEST_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Token expired');
  });

  it('should return 401 when token has no userId', async () => {
    mockVerify.mockResolvedValueOnce({ tenant_id: 1 });

    const app = createApp();
    app.use('*', authenticateToken);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { authorization: 'Bearer no-user-token' },
    }, TEST_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Invalid token - missing claims');
  });

  it('should return 401 when token has no tenant_id', async () => {
    mockVerify.mockResolvedValueOnce({ userId: 1 });

    const app = createApp();
    app.use('*', authenticateToken);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { authorization: 'Bearer no-tenant-token' },
    }, TEST_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Invalid token - missing claims');
  });

  // The failed-verify throttle is keyed by IP in a module-level store that
  // survives across tests, so these use unique x-forwarded-for addresses to
  // stay isolated from each other and from the plain invalid-token test above.
  it('returns 429 after repeated invalid-signature failures from one IP', async () => {
    mockVerify.mockRejectedValue(new Error('Invalid'));

    const app = createApp();
    app.use('*', authenticateToken);
    app.get('/test', (c) => c.json({ ok: true }));

    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      last = await app.request('/test', {
        headers: { authorization: 'Bearer forged-token', 'x-forwarded-for': '203.0.113.9' },
      }, TEST_ENV);
    }
    expect(last!.status).toBe(429);
  });

  it('never throttles expired tokens — they are validly signed, not an attack', async () => {
    const error = new Error('Token expired');
    error.name = 'JwtTokenExpired';
    mockVerify.mockRejectedValue(error);

    const app = createApp();
    app.use('*', authenticateToken);
    app.get('/test', (c) => c.json({ ok: true }));

    let last: Response | undefined;
    for (let i = 0; i < 35; i++) {
      last = await app.request('/test', {
        headers: { authorization: 'Bearer expired-token', 'x-forwarded-for': '203.0.113.10' },
      }, TEST_ENV);
    }
    expect(last!.status).toBe(401);
    expect((await last!.json()).message).toBe('Token expired');
  });

  it('should set user and tenantId on context from JWT claims when token is valid', async () => {
    mockVerify.mockResolvedValueOnce({ userId: 1, tenant_id: 42 });

    const app = createApp();
    app.use('*', authenticateToken);
    app.get('/test', (c) => {
      const user = c.get('user');
      const tenantId = c.get('tenantId');
      return c.json({ userId: user.users_id, tenantId });
    });

    const res = await app.request('/test', {
      headers: { authorization: 'Bearer valid-token' },
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(1);
    expect(body.tenantId).toBe(42);
  });
});

describe('requirePermission middleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
  });

  function createAuthenticatedApp(user: any) {
    const app = createApp();
    app.use('*', async (c, next) => {
      c.set('user', user);
      c.set('tenantId', user.tenant_id);
      await next();
    });
    return app;
  }

  // A partial (JWT-claims-only) user has no `role` field, so requirePermission
  // must fall through to the cached DB lookup — this is the path that now
  // goes through the shared framework/backend createEntityCache instead of a
  // hand-rolled Map, so it needs its own coverage rather than relying on the
  // full-user tests above, which all bypass the lookup by setting role upfront.
  function createPartialUserApp(partial: { users_id: number; tenant_id: number }) {
    const app = createApp();
    app.use('*', async (c, next) => {
      c.set('user', partial);
      c.set('tenantId', partial.tenant_id);
      await next();
    });
    return app;
  }

  it('loads and caches the full user from the DB when context has only JWT claims', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ users_id: 6, role: 'admin', tenant_id: 1, permissions: {}, active: true, is_super_admin: false }],
    } as any);
    const app = createPartialUserApp({ users_id: 6, tenant_id: 1 });
    app.get('/test', requirePermission('meter:read'), (c) => c.json({ role: c.get('user').role }));

    const res = await app.request('/test', {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe('admin');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns 401 when the cached DB lookup finds no matching user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = createPartialUserApp({ users_id: 7, tenant_id: 1 });
    app.get('/test', requirePermission('meter:read'), (c) => c.json({ ok: true }));

    const res = await app.request('/test', {}, TEST_ENV);
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe('User not found');
  });

  it('returns 401 when the looked-up user is inactive', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ users_id: 8, role: 'viewer', tenant_id: 1, permissions: [], active: false }],
    } as any);
    const app = createPartialUserApp({ users_id: 8, tenant_id: 1 });
    app.get('/test', requirePermission('meter:read'), (c) => c.json({ ok: true }));

    const res = await app.request('/test', {}, TEST_ENV);
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe('Account is inactive');
  });

  it('should allow admin users regardless of permission', async () => {
    const app = createAuthenticatedApp({
      users_id: 1, role: 'admin', tenant_id: 1, permissions: {},
    });
    app.get('/test', requirePermission('meter:delete'), (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('should allow users with matching array permission', async () => {
    const app = createAuthenticatedApp({
      users_id: 2, role: 'viewer', tenant_id: 1,
      permissions: ['meter:read', 'location:read'],
    });
    app.get('/test', requirePermission('meter:read'), (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('should allow users with matching nested object permission', async () => {
    const app = createAuthenticatedApp({
      users_id: 3, role: 'manager', tenant_id: 1,
      permissions: { meter: { read: true, update: true } },
    });
    app.get('/test', requirePermission('meter:read'), (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('should deny users without the required permission (array)', async () => {
    const app = createAuthenticatedApp({
      users_id: 4, role: 'viewer', tenant_id: 1,
      permissions: ['location:read'],
    });
    app.get('/test', requirePermission('meter:delete'), (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toBe('Insufficient permissions');
  });

  it('should deny users without the required permission (nested object)', async () => {
    const app = createAuthenticatedApp({
      users_id: 5, role: 'technician', tenant_id: 1,
      permissions: { meter: { read: true } },
    });
    app.get('/test', requirePermission('meter:delete'), (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(403);
  });

  it('should return 401 when no user is set', async () => {
    const app = createApp();
    app.get('/test', requirePermission('meter:read'), (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Authentication required');
  });
});

describe('authenticateSyncServer middleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearSyncTenantCache();
  });

  it('should return 401 when no API key header is provided', async () => {
    const app = createApp();
    app.use('*', authenticateSyncServer);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {}, TEST_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('API key required');
  });

  it('should return 401 when API key is invalid', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = createApp();
    app.use('*', authenticateSyncServer);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { 'x-api-key': 'invalid-key' },
    }, TEST_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Invalid API key');
  });

  it('should set tenantId when API key is valid', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tenant_id: 10 }] } as any);

    const app = createApp();
    app.use('*', authenticateSyncServer);
    app.get('/test', (c) => {
      return c.json({ tenantId: c.get('tenantId') });
    });

    const res = await app.request('/test', {
      headers: { 'x-api-key': 'valid-key' },
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(10);
  });

  it('caches the key→tenant lookup so repeat polls skip the DB', async () => {
    mockQuery.mockResolvedValue({ rows: [{ tenant_id: 10 }] } as any);

    const app = createApp();
    app.use('*', authenticateSyncServer);
    app.get('/test', (c) => c.json({ tenantId: c.get('tenantId') }));

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/test', {
        headers: { 'x-api-key': 'cached-key' },
      }, TEST_ENV);
      expect(res.status).toBe(200);
      expect((await res.json()).tenantId).toBe(10);
    }
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not cache invalid keys — a later valid key still gets looked up', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = createApp();
    app.use('*', authenticateSyncServer);
    app.get('/test', (c) => c.json({ tenantId: c.get('tenantId') }));

    const bad = await app.request('/test', {
      headers: { 'x-api-key': 'not-yet-active-key' },
    }, TEST_ENV);
    expect(bad.status).toBe(401);

    mockQuery.mockResolvedValueOnce({ rows: [{ tenant_id: 11 }] } as any);
    const good = await app.request('/test', {
      headers: { 'x-api-key': 'not-yet-active-key' },
    }, TEST_ENV);
    expect(good.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
