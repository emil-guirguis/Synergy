import { describe, it, expect, vi, beforeEach } from 'vitest';

// A custom role with NO notification grants — the 2026-10-22 case where a
// brand-new role 403'd its own bell.
let currentGrants: string[] = [];
const ME = 'u-me';

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', { id: ME });
    c.set('userId', ME);
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) => {
    if (!currentGrants.includes(permission)) {
      return c.json({ success: false, message: 'Insufficient permissions' }, 403);
    }
    return next();
  },
  permissionsFor: async () => ({ has: (p: string) => currentGrants.includes(p) }),
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({ execQuery: (...a: any[]) => mockExecQuery(...a) }));

const fw = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  countNotifications: vi.fn(),
  createNotification: vi.fn(),
  acknowledgeNotification: vi.fn(),
  deleteNotification: vi.fn(),
  deleteAllNotifications: vi.fn(),
}));
vi.mock('@meterit/framework-backend/api/base/notifications', () => ({
  ...fw,
  senderDisplayName: () => 'Me',
  NotificationValidationError: class extends Error {},
}));

import app from './notifications';

const req = (path: string, init?: RequestInit) => app.request(path, init, {} as any);

beforeEach(() => {
  vi.clearAllMocks();
  currentGrants = [];
});

describe('own feed needs no role grant', () => {
  it('lists and counts the caller\'s own feed', async () => {
    fw.listNotifications.mockResolvedValue({ notifications: [], total: 0 });
    fw.countNotifications.mockResolvedValue(3);
    expect((await req('/?limit=100&offset=0')).status).toBe(200);
    expect(fw.listNotifications.mock.calls[0][3]).toBe(ME);
    expect((await req('/count')).status).toBe(200);
  });

  it('acknowledges and clears the caller\'s own feed', async () => {
    fw.acknowledgeNotification.mockResolvedValue({ notification_id: 1 });
    fw.deleteAllNotifications.mockResolvedValue(2);
    expect((await req('/1/acknowledge', { method: 'POST' })).status).toBe(200);
    expect((await req('/', { method: 'DELETE' })).status).toBe(200);
    expect(fw.deleteAllNotifications.mock.calls[0][3]).toBe(ME);
  });

  it('deletes the caller\'s own notification', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ users_id: ME }] });
    fw.deleteNotification.mockResolvedValue(true);
    expect((await req('/5', { method: 'DELETE' })).status).toBe(200);
  });
});

describe('what reaches other people still needs the grant', () => {
  it('403s deleting someone else\'s notification (or a broadcast) without notification:delete', async () => {
    for (const users_id of ['u-other', null]) {
      mockExecQuery.mockResolvedValue({ rows: [{ users_id }] });
      expect((await req('/5', { method: 'DELETE' })).status).toBe(403);
    }
    expect(fw.deleteNotification).not.toHaveBeenCalled();
  });

  it('allows it with notification:delete', async () => {
    currentGrants = ['notification:delete'];
    mockExecQuery.mockResolvedValue({ rows: [{ users_id: 'u-other' }] });
    fw.deleteNotification.mockResolvedValue(true);
    expect((await req('/5', { method: 'DELETE' })).status).toBe(200);
  });

  it('404s a notification that does not exist', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    expect((await req('/5', { method: 'DELETE' })).status).toBe(404);
  });

  it('403s sending without notification:write', async () => {
    const res = await req('/', { method: 'POST', body: JSON.stringify({ title: 'x' }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(403);
    expect(fw.createNotification).not.toHaveBeenCalled();
  });
});
