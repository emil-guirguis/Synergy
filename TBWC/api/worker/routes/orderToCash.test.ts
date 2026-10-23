import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentPermSet = new Set(['orderToCash:read']);

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', { id: 'admin' });
    c.set('userId', 'admin');
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) => {
    if (!currentPermSet.has(permission)) {
      return c.json({ success: false, message: 'Insufficient permissions' }, 403);
    }
    c.set('permissions', { scopeOf: () => 'all' });
    return next();
  },
  visibleRepListIds: () => [],
  reportRepScope: () => null,
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import orderToCashApp from './orderToCash';

const ENV = {} as any;
const req = (path: string) => orderToCashApp.request(path, undefined, ENV);
const CURRENT_YEAR = new Date().getFullYear();

/** The `year` parameter each query was given, by label. */
function yearParams(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [, , params, label] of mockExecQuery.mock.calls) {
    out[label] = label === 'orderToCash.uninvoiced' ? params[1] : params[0];
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentPermSet = new Set(['orderToCash:read']);
  mockExecQuery.mockResolvedValue({ rows: [] });
});

describe('permission gate', () => {
  it('403s without orderToCash:read', async () => {
    currentPermSet = new Set();
    const res = await req('/summary');
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('year filter', () => {
  it('defaults to the current year', async () => {
    const res = await req('/summary');
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.year).toBe(CURRENT_YEAR);
    const years = yearParams();
    expect(years['orderToCash.openSummary']).toBe(CURRENT_YEAR);
    expect(years['orderToCash.uninvoiced']).toBe(CURRENT_YEAR);
    expect(years['orderToCash.collectionSpeed']).toBe(CURRENT_YEAR);
  });

  it('honours an explicit year', async () => {
    const res = await req('/summary?year=2024');
    expect((await res.json() as any).data.year).toBe(2024);
    expect(yearParams()['orderToCash.openSummary']).toBe(2024);
  });

  it('year=all opts out of the filter entirely', async () => {
    const res = await req('/summary?year=all');
    expect((await res.json() as any).data.year).toBe('all');
    const years = yearParams();
    expect(years['orderToCash.openSummary']).toBeNull();
    expect(years['orderToCash.uninvoiced']).toBeNull();
    expect(years['orderToCash.collectionSpeed']).toBeNull();
  });

  it('falls back to the current year for junk', async () => {
    const res = await req('/summary?year=bogus');
    expect((await res.json() as any).data.year).toBe(CURRENT_YEAR);
  });
});
