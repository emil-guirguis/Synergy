import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const mockVerify = vi.fn();
const mockExec = vi.fn();

vi.mock('./supabaseVerify', () => ({
  verifySupabaseToken: (...a: any[]) => mockVerify(...a),
}));
vi.mock('./db', () => ({
  execQuery: (...a: any[]) => mockExec(...a),
}));

import { authenticateToken, loadProfile } from './middleware';

const ENV = {} as any;

/** Small app: auth on everything, echo the loaded user. */
function makeApp() {
  const app = new Hono<any>();
  app.use('*', authenticateToken);
  app.get('/me', (c) => c.json({ user: c.get('user'), userId: c.get('userId') }));
  return app;
}

const profile = (over: Record<string, any> = {}) => ({
  id: 'u1', email: 'a@b.com', approved: true, ...over,
});

beforeEach(() => {
  mockVerify.mockReset();
  mockExec.mockReset();
});

describe('authenticateToken', () => {
  it('401 when no Authorization header', async () => {
    const res = await makeApp().request('/me', {}, ENV);
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe('Access token required');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('401 when the header is not a Bearer token', async () => {
    const res = await makeApp().request('/me', { headers: { authorization: 'Basic abc' } }, ENV);
    expect(res.status).toBe(401);
  });

  it('401 when the token fails Supabase verification', async () => {
    mockVerify.mockResolvedValue(null);
    const res = await makeApp().request('/me', { headers: { authorization: 'Bearer bad' } }, ENV);
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe('Invalid or expired token');
  });

  it('429s after repeated failed verifications from the same IP', async () => {
    // Distinct IP so this doesn't share a rate-limit bucket with the other
    // failed-verification test above (module-level counter in the shared
    // framework rate limiter persists across `it`s in this file).
    mockVerify.mockResolvedValue(null);
    const headers = { authorization: 'Bearer bad', 'x-forwarded-for': '203.0.113.9' };
    let last;
    for (let i = 0; i < 31; i++) {
      last = await makeApp().request('/me', { headers }, ENV);
    }
    expect(last!.status).toBe(429);
    expect((await last!.json()).message).toBe('Too many failed attempts, please try again later');
  });

  it('403 when no matching profile row exists', async () => {
    mockVerify.mockResolvedValue({ userId: 'no-profile-user', email: null });
    mockExec.mockResolvedValue({ rows: [] });
    const res = await makeApp().request('/me', { headers: { authorization: 'Bearer t' } }, ENV);
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('No user profile found');
  });

  it('403 when the profile is not approved', async () => {
    mockVerify.mockResolvedValue({ userId: 'pending-user', email: null });
    mockExec.mockResolvedValue({ rows: [profile({ id: 'pending-user', approved: false })] });
    const res = await makeApp().request('/me', { headers: { authorization: 'Bearer t' } }, ENV);
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('Account pending approval');
  });

  it('passes and exposes userId + profile on the context', async () => {
    mockVerify.mockResolvedValue({ userId: 'ok-user', email: 'a@b.com' });
    mockExec.mockResolvedValue({ rows: [profile({ id: 'ok-user' })] });
    const res = await makeApp().request('/me', { headers: { authorization: 'Bearer t' } }, ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('ok-user');
    expect(body.user.id).toBe('ok-user');
  });
});

describe('loadProfile caching', () => {
  it('queries the DB once then serves the cached profile within TTL', async () => {
    mockExec.mockResolvedValue({ rows: [profile({ id: 'cache-user' })] });
    const a = await loadProfile(ENV, 'cache-user');
    const b = await loadProfile(ENV, 'cache-user');
    expect(a).toBe(b);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('returns null when the user has no profile', async () => {
    mockExec.mockResolvedValue({ rows: [] });
    expect(await loadProfile(ENV, 'missing-user')).toBeNull();
  });
});
