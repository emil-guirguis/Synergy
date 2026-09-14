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
import rolesApp from './roles';
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

// Every catalogued permission except role:write — used to exercise the
// last-admin guard and the 403-without-role:write paths.
const NO_ROLE_WRITE_GRANTS = [
  { permission: 'role:read', scope: 'all', hidden_fields: [] },
];

function setupAuth() {
  mockVerify.mockResolvedValue({ userId: 1, tenant_id: 1 });
  mockQuery.mockImplementation(authQuery(ADMIN_USER));
}

const auth = (method = 'GET', body?: any) => ({
  method,
  headers: {
    authorization: 'Bearer valid-token',
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

describe('Roles Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('permission gate', () => {
    it('403s GET / without role:read', async () => {
      queueAuth(mockQuery, ADMIN_USER, NO_ROLE_WRITE_GRANTS.filter((g) => g.permission !== 'role:read'));
      const res = await rolesApp.request('/', auth(), TEST_ENV);
      expect(res.status).toBe(403);
    });

    it('403s POST / without role:write', async () => {
      queueAuth(mockQuery, ADMIN_USER, NO_ROLE_WRITE_GRANTS);
      const res = await rolesApp.request('/', auth('POST', { code: 'auditor', name: 'Auditor' }), TEST_ENV);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /', () => {
    it('scopes every query to system roles or the caller tenant', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ role_id: 1, tenant_id: null, code: 'admin', name: 'Administrator', is_system: true }] })
        .mockResolvedValueOnce({ rows: [{ role_id: 1, permission: 'meter:read', scope: 'all', hidden_fields: [] }] })
        .mockResolvedValueOnce({ rows: [{ role_id: 1, user_count: 4 }] });

      const res = await rolesApp.request('/', auth(), TEST_ENV);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.items).toEqual([{
        role_id: 1, tenant_id: null, code: 'admin', name: 'Administrator', is_system: true,
        user_count: 4, grants: [{ permission: 'meter:read', scope: 'all', hidden_fields: [] }],
      }]);

      // Calls: [0]=user lookup, [1]=grant lookup (auth), [2]=roles.list, [3]=roles.grants, [4]=roles.userCounts
      expect(mockQuery.mock.calls[2][1]).toMatch(/tenant_id IS NULL OR tenant_id = \$1/);
      expect(mockQuery.mock.calls[2][2]).toEqual([1]);
      expect(mockQuery.mock.calls[4][2]).toEqual([1]);
    });

    it('defaults grants/user_count to empty for a role with neither', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ role_id: 2, tenant_id: 1, code: 'auditor', name: 'Auditor', is_system: false }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await rolesApp.request('/', auth(), TEST_ENV);
      const body: any = await res.json();
      expect(body.data.items[0]).toEqual(expect.objectContaining({ user_count: 0, grants: [] }));
    });
  });

  describe('GET /catalog', () => {
    it('returns the code-defined permission catalog with no DB calls beyond auth', async () => {
      queueAuth(mockQuery, ADMIN_USER);
      const res = await rolesApp.request('/catalog', auth(), TEST_ENV);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.permissions).toContain('role:write');
      expect(mockQuery).toHaveBeenCalledTimes(2); // only the auth lookups
    });
  });

  describe('POST /', () => {
    it('rejects an invalid code before touching the DB', async () => {
      queueAuth(mockQuery, ADMIN_USER);
      const res = await rolesApp.request('/', auth('POST', { code: 'Auditor1', name: 'Auditor' }), TEST_ENV);
      expect(res.status).toBe(400);
      expect(mockQuery).toHaveBeenCalledTimes(2); // just auth, no route queries
    });

    it('rejects a grant naming a permission outside the catalog', async () => {
      queueAuth(mockQuery, ADMIN_USER);
      const res = await rolesApp.request('/', auth('POST', {
        code: 'auditor', name: 'Auditor', grants: [{ permission: 'meter:approve' }],
      }), TEST_ENV);
      expect(res.status).toBe(400);
      expect((await res.json()).message).toContain('meter:approve');
    });

    it('409s when the code already exists for this tenant or system-wide', async () => {
      queueAuth(mockQuery, ADMIN_USER).mockResolvedValueOnce({ rows: [{}] });
      const res = await rolesApp.request('/', auth('POST', { code: 'admin', name: 'Administrator' }), TEST_ENV);
      expect(res.status).toBe(409);
    });

    it('creates a tenant-scoped role, inserts grants, and clears the permission cache', async () => {
      const clearSpy = vi.spyOn(await import('../middleware'), 'clearPermissionCache');
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] }) // dup check
        .mockResolvedValueOnce({ rows: [{ role_id: 9 }] }) // insert role
        .mockResolvedValueOnce({ rows: [] }); // insert grant

      const res = await rolesApp.request('/', auth('POST', {
        code: 'auditor', name: 'Auditor', grants: [{ permission: 'meter:read', scope: 'own' }],
      }), TEST_ENV);

      expect(res.status).toBe(200);
      expect((await res.json()).data.role_id).toBe(9);
      // tenant_id (1) is bound into the INSERT, unlike TBWC's single-tenant version.
      expect(mockQuery.mock.calls[3]).toEqual([
        TEST_ENV,
        expect.stringContaining('INSERT INTO public.role'),
        [1, 'auditor', 'Auditor'],
      ]);
      expect(clearSpy).toHaveBeenCalled();
    });
  });

  describe('PUT /:id', () => {
    it('rejects a blank name without touching the DB', async () => {
      queueAuth(mockQuery, ADMIN_USER);
      const res = await rolesApp.request('/1', auth('PUT', { name: '' }), TEST_ENV);
      expect(res.status).toBe(400);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("404s a system role — tenant_id NULL never matches the caller's tenant_id", async () => {
      queueAuth(mockQuery, ADMIN_USER).mockResolvedValueOnce({ rows: [] }); // ownRole finds nothing
      const res = await rolesApp.request('/1', auth('PUT', { name: 'Renamed' }), TEST_ENV);
      expect(res.status).toBe(404);
    });

    it("404s a role owned by another tenant", async () => {
      queueAuth(mockQuery, ADMIN_USER).mockResolvedValueOnce({ rows: [] });
      const res = await rolesApp.request('/77', auth('PUT', { name: 'Renamed' }), TEST_ENV);
      expect(res.status).toBe(404);
      expect(mockQuery.mock.calls[2][2]).toEqual(['77', 1]);
    });

    it('renames a role this tenant owns', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ role_id: 2, code: 'auditor', is_system: false, tenant_id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ role_id: 2, code: 'auditor', name: 'Renamed', is_system: false }] });
      const res = await rolesApp.request('/2', auth('PUT', { name: 'Renamed' }), TEST_ENV);
      expect(res.status).toBe(200);
      expect((await res.json()).data.name).toBe('Renamed');
    });
  });

  describe('PUT /:id/grants', () => {
    it('404s when the role is not owned by this tenant', async () => {
      queueAuth(mockQuery, ADMIN_USER).mockResolvedValueOnce({ rows: [] });
      const res = await rolesApp.request('/1/grants', auth('PUT', { grants: [] }), TEST_ENV);
      expect(res.status).toBe(404);
    });

    it('blocks dropping role:write when no other role in scope would hold it', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ role_id: 2, code: 'auditor', is_system: false, tenant_id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] });
      const res = await rolesApp.request('/2/grants', auth('PUT', {
        grants: [{ permission: 'meter:read' }],
      }), TEST_ENV);
      expect(res.status).toBe(409);
      expect((await res.json()).message).toContain('only role that can manage roles');
    });

    it('replaces grants wholesale when role:write survives', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ role_id: 2, code: 'auditor', is_system: false, tenant_id: 1 }] })
        .mockResolvedValueOnce({ rows: [] }) // clear
        .mockResolvedValueOnce({ rows: [] }); // insert
      const res = await rolesApp.request('/2/grants', auth('PUT', {
        grants: [{ permission: 'role:write' }, { permission: 'meter:read', scope: 'own' }],
      }), TEST_ENV);
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[3][1]).toContain('DELETE FROM public.role_permission');
    });
  });

  describe('DELETE /:id', () => {
    it('404s a role from another tenant', async () => {
      queueAuth(mockQuery, ADMIN_USER).mockResolvedValueOnce({ rows: [] });
      const res = await rolesApp.request('/1', auth('DELETE'), TEST_ENV);
      expect(res.status).toBe(404);
    });

    it('409s a system role', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ role_id: 1, code: 'admin', is_system: true, tenant_id: 1 }] });
      const res = await rolesApp.request('/1', auth('DELETE'), TEST_ENV);
      expect(res.status).toBe(409);
      expect((await res.json()).message).toContain('built-in');
    });

    it('409s when users still hold the role', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ role_id: 2, code: 'auditor', is_system: false, tenant_id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ n: 3 }] });
      const res = await rolesApp.request('/2', auth('DELETE'), TEST_ENV);
      expect(res.status).toBe(409);
      expect((await res.json()).message).toContain('reassign them first');
    });

    it('deletes an unassigned tenant role', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ role_id: 2, code: 'auditor', is_system: false, tenant_id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      const res = await rolesApp.request('/2', auth('DELETE'), TEST_ENV);
      expect(res.status).toBe(200);
      expect((await res.json()).data.role_id).toBe(2);
    });
  });
});
