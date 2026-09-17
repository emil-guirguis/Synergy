import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable auth guard, mirroring the real middleware contract.
let currentUser: any = null;

const grants = [{ permission: 'order:read', scope: 'all', hidden_fields: [] }];

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    if (!currentUser) return c.json({ success: false, message: 'Access token required' }, 401);
    c.set('user', currentUser);
    c.set('userId', currentUser.id);
    return next();
  },
  permissionsFor: async () => ({ list: () => grants }),
}));

import authApp from './auth';

const ENV = {} as any;

beforeEach(() => {
  currentUser = null;
});

describe('GET /api/auth/me', () => {
  it('401 when unauthenticated (guard rejects)', async () => {
    const res = await authApp.request('/me', {}, ENV);
    expect(res.status).toBe(401);
  });

  it('returns the authenticated caller profile', async () => {
    currentUser = { id: 'u1', email: 'a@b.com', is_admin: true, approved: true };
    const res = await authApp.request('/me', { headers: { authorization: 'Bearer t' } }, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { ...currentUser, permissions: grants } });
  });
});
