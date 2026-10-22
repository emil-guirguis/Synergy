import { describe, it, expect, vi, beforeEach } from 'vitest';

// Curating the catalog (Type/Notes edits, image review) is narrower than the
// inventory:write grant that opens the routes: permissions.ts's
// CATALOG_CURATOR_EMAILS decides, and that is a code-owned list of people. The
// real isCatalogCurator() is used here — only the caller's identity is faked.
let currentUser: any = { id: 'u1', email: 'emilguirguis@yahoo.com' };
let currentGrants: string[] = ['inventory:read', 'inventory:write'];

vi.mock('../middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware')>();
  return {
    ...actual,
    authenticateToken: (c: any, next: any) => {
      c.set('user', currentUser);
      c.set('userId', currentUser.id);
      return next();
    },
    requirePermission: (permission: string) => (c: any, next: any) => {
      if (!currentGrants.includes(permission)) {
        return c.json({ success: false, message: 'Insufficient permissions' }, 403);
      }
      c.set('permissions', { has: (p: string) => currentGrants.includes(p) });
      return next();
    },
  };
});

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
  withTransaction: vi.fn(),
}));

const mockUpdate = vi.fn();
vi.mock('../crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crud')>();
  return { ...actual, update: (...a: any[]) => mockUpdate(...a) };
});

import inventoryApp from './inventory';

const ENV = {} as any;
const json = (method: string, path: string, body: any) =>
  inventoryApp.request(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, ENV);

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'u1', email: 'emilguirguis@yahoo.com' };
  currentGrants = ['inventory:read', 'inventory:write'];
  mockUpdate.mockResolvedValue({ qb_item_id: 7, type: 'kit' });
  mockExecQuery.mockResolvedValue({ rows: [{ qb_item_id: 7, image_status: 'approved' }] });
});

describe('catalog curation (PUT /:id)', () => {
  it('writes Type/Notes for a curator', async () => {
    const res = await json('PUT', '/7', { type: 'kit', notes: 'bundle' });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      ENV, 'qb_item', 'qb_item_id', '7', { type: 'kit', notes: 'bundle' }, { touchUpdatedAt: false }
    );
  });

  // The point of the list: holding inventory:write is not enough.
  it('403s a non-curator who holds inventory:write', async () => {
    currentUser = { id: 'u2', email: 'someone.else@tbwcinc.com' };
    const res = await json('PUT', '/7', { type: 'kit' });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('403s before validating the body', async () => {
    currentUser = { id: 'u2', email: 'someone.else@tbwcinc.com' };
    const res = await json('PUT', '/7', { type: 'not-a-type' });
    expect(res.status).toBe(403);
  });

  it('still 403s a caller without inventory:write at all', async () => {
    currentGrants = ['inventory:read'];
    const res = await json('PUT', '/7', { type: 'kit' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, message: 'Insufficient permissions' });
  });
});

describe('catalog curation (PATCH /:id/image)', () => {
  it('records an image verdict for a curator', async () => {
    const res = await json('PATCH', '/7/image', { image_status: 'approved' });
    expect(res.status).toBe(200);
    expect(mockExecQuery).toHaveBeenCalled();
  });

  it('403s a non-curator who holds inventory:write', async () => {
    currentUser = { id: 'u2', email: 'someone.else@tbwcinc.com' };
    const res = await json('PATCH', '/7/image', { image_status: 'approved' });
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  // The email check is case/whitespace-insensitive (framework canImpersonate).
  it('accepts the curator address in any casing', async () => {
    currentUser = { id: 'u1', email: '  EmilGuirguis@Yahoo.com ' };
    const res = await json('PATCH', '/7/image', { image_status: 'rejected' });
    expect(res.status).toBe(200);
  });

  it('403s a caller with no email at all', async () => {
    currentUser = { id: 'u3', email: null };
    const res = await json('PATCH', '/7/image', { image_status: 'approved' });
    expect(res.status).toBe(403);
  });
});
