import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable auth: adjust `currentGrants` to exercise the permission gate.
let currentUser: any = { id: 'admin' };
let currentGrants: string[] = ['role:read', 'role:write'];
const clearPermissionCache = vi.fn();

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    if (!currentUser) return c.json({ success: false, message: 'Access token required' }, 401);
    c.set('user', currentUser);
    c.set('userId', currentUser.id);
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) =>
    currentGrants.includes(permission)
      ? next()
      : c.json({ success: false, message: 'Insufficient permissions' }, 403),
  clearPermissionCache: (...a: any[]) => clearPermissionCache(...a),
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import rolesApp from './roles';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => rolesApp.request(path, init, ENV);
const json = (method: string, body: any) => ({
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

/** Queue execQuery resolutions in call order. */
function queue(...rows: any[][]) {
  for (const r of rows) mockExecQuery.mockResolvedValueOnce({ rows: r, rowCount: r.length });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin' };
  currentGrants = ['role:read', 'role:write'];
});

describe('permission gate', () => {
  it('403s GET / without role:read', async () => {
    currentGrants = [];
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('403s mutating routes without role:write', async () => {
    currentGrants = ['role:read'];
    const res = await req('/', json('POST', { code: 'auditor', name: 'Auditor' }));
    expect(res.status).toBe(403);
  });
});

describe('GET /', () => {
  it('assembles roles with their grants and user counts', async () => {
    queue(
      [{ role_id: 1, code: 'admin', name: 'Administrator', is_system: true }],
      [{ role_id: 1, permission: 'order:read', scope: 'all', hidden_fields: [] }],
      [{ role_id: 1, user_count: 3 }],
    );
    const res = await req('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: {
        items: [{
          role_id: 1, code: 'admin', name: 'Administrator', is_system: true,
          user_count: 3,
          grants: [{ permission: 'order:read', scope: 'all', hidden_fields: [] }],
        }],
      },
    });
  });

  it('defaults user_count to 0 and grants to [] for a role with neither', async () => {
    queue([{ role_id: 2, code: 'rep', name: 'Sales Rep', is_system: true }], [], []);
    const res = await req('/');
    const body: any = await res.json();
    expect(body.data.items[0]).toEqual(expect.objectContaining({ user_count: 0, grants: [] }));
  });
});

describe('GET /catalog', () => {
  it('returns the code-defined permission catalog', async () => {
    const res = await req('/catalog');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.permissions).toContain('role:write');
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('POST /', () => {
  it('rejects a code with uppercase or leading digits', async () => {
    const res = await req('/', json('POST', { code: 'Auditor1', name: 'Auditor' }));
    expect(res.status).toBe(400);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('rejects a missing name', async () => {
    const res = await req('/', json('POST', { code: 'auditor', name: '  ' }));
    expect(res.status).toBe(400);
  });

  it('rejects a grant naming a permission outside the catalog', async () => {
    const res = await req('/', json('POST', {
      code: 'auditor', name: 'Auditor', grants: [{ permission: 'order:approve' }],
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      success: false, message: expect.stringContaining('order:approve'),
    }));
  });

  it('409s when the code already exists', async () => {
    queue([{ role_id: 5 }]);
    const res = await req('/', json('POST', { code: 'admin', name: 'Administrator' }));
    expect(res.status).toBe(409);
  });

  it('creates the role, inserts each grant, and clears the permission cache', async () => {
    queue([], [{ role_id: 9 }]);
    mockExecQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // grant insert
    const res = await req('/', json('POST', {
      code: 'auditor', name: 'Auditor',
      grants: [{ permission: 'order:read', scope: 'own', hidden_fields: ['commission'] }],
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { role_id: 9 } });
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining('INSERT INTO public.role_permission'),
      [9, 'order:read', 'own', ['commission']],
      'roles.create.grant'
    );
    expect(clearPermissionCache).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /:id', () => {
  it('rejects a blank name', async () => {
    const res = await req('/1', json('PUT', { name: '' }));
    expect(res.status).toBe(400);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('404s when the role does not exist', async () => {
    queue([]);
    const res = await req('/999', json('PUT', { name: 'New Name' }));
    expect(res.status).toBe(404);
  });

  it('renames and returns the updated row', async () => {
    queue([{ role_id: 1, code: 'admin', name: 'New Name', is_system: true }]);
    const res = await req('/1', json('PUT', { name: 'New Name' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { role_id: 1, code: 'admin', name: 'New Name', is_system: true },
    });
  });
});

describe('PUT /:id/grants', () => {
  it('404s when the role does not exist', async () => {
    queue([]);
    const res = await req('/999/grants', json('PUT', { grants: [] }));
    expect(res.status).toBe(404);
  });

  it('blocks dropping role:write when no other role would hold it', async () => {
    queue([{ role_id: 1, code: 'admin' }], [{ n: 0 }]);
    const res = await req('/1/grants', json('PUT', { grants: [{ permission: 'order:read' }] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({
      message: expect.stringContaining('only role that can manage roles'),
    }));
    expect(clearPermissionCache).not.toHaveBeenCalled();
  });

  it('allows dropping role:write when another role still holds it', async () => {
    queue([{ role_id: 1, code: 'admin' }], [{ n: 1 }]);
    mockExecQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // clear
    mockExecQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // insert
    const res = await req('/1/grants', json('PUT', { grants: [{ permission: 'order:read' }] }));
    expect(res.status).toBe(200);
    expect(clearPermissionCache).toHaveBeenCalledTimes(1);
  });

  it('replaces grants wholesale: clears then re-inserts each one', async () => {
    queue([{ role_id: 2, code: 'rep' }]); // find (role:write kept, no last-admin check)
    mockExecQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // clear
    mockExecQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // insert
    const res = await req('/2/grants', json('PUT', {
      grants: [{ permission: 'role:write' }, { permission: 'order:read', scope: 'own' }],
    }));
    expect(res.status).toBe(200);
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV, expect.stringContaining('DELETE FROM public.role_permission'), ['2'], 'roles.grants.clear'
    );
  });
});

describe('DELETE /:id', () => {
  it('404s when the role does not exist', async () => {
    queue([]);
    const res = await req('/999', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('409s for a system role', async () => {
    queue([{ role_id: 1, code: 'admin', is_system: true, user_count: 0 }]);
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({
      message: expect.stringContaining('built-in'),
    }));
  });

  it('409s when users still hold the role', async () => {
    queue([{ role_id: 9, code: 'auditor', is_system: false, user_count: 2 }]);
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({
      message: expect.stringContaining('reassign them first'),
    }));
  });

  it('deletes an unassigned custom role and clears the permission cache', async () => {
    queue([{ role_id: 9, code: 'auditor', is_system: false, user_count: 0 }]);
    mockExecQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // delete
    const res = await req('/9', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { role_id: 9 } });
    expect(clearPermissionCache).toHaveBeenCalledTimes(1);
  });
});
