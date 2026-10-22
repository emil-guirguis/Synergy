import { describe, it, expect, vi } from 'vitest';
import { canImpersonate, checkRateLimit, createEntityCache, extractBearerToken, requireCheck } from './auth';

describe('checkRateLimit', () => {
  it('allows up to maxRequests within the window, then denies', () => {
    const key = `test:${Math.random()}`;
    expect(checkRateLimit(key, 2, 60_000)).toBe(true);
    expect(checkRateLimit(key, 2, 60_000)).toBe(true);
    expect(checkRateLimit(key, 2, 60_000)).toBe(false);
  });

  it('tracks separate keys independently', () => {
    const a = `a:${Math.random()}`;
    const b = `b:${Math.random()}`;
    expect(checkRateLimit(a, 1, 60_000)).toBe(true);
    expect(checkRateLimit(b, 1, 60_000)).toBe(true);
    expect(checkRateLimit(a, 1, 60_000)).toBe(false);
  });
});

describe('createEntityCache', () => {
  it('caches a fetched value and does not re-fetch while fresh', async () => {
    const cache = createEntityCache<{ id: number }>(60_000);
    const fetch = vi.fn().mockResolvedValue({ id: 1 });
    const first = await cache.get('k1', fetch);
    const second = await cache.get('k1', fetch);
    expect(first).toEqual({ id: 1 });
    expect(second).toEqual({ id: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('de-dupes concurrent fetches for the same key', async () => {
    const cache = createEntityCache<{ id: number }>(60_000);
    let resolveFetch: (v: { id: number }) => void;
    const fetch = vi.fn(() => new Promise<{ id: number }>((r) => { resolveFetch = r; }));

    const p1 = cache.get('k1', fetch);
    const p2 = cache.get('k1', fetch);
    resolveFetch!({ id: 42 });

    expect(await p1).toEqual({ id: 42 });
    expect(await p2).toEqual({ id: 42 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a null result', async () => {
    const cache = createEntityCache<{ id: number }>(60_000);
    const fetch = vi.fn().mockResolvedValue(null);
    await cache.get('k1', fetch);
    await cache.get('k1', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('clear() forces the next get() to re-fetch', async () => {
    const cache = createEntityCache<{ id: number }>(60_000);
    const fetch = vi.fn().mockResolvedValue({ id: 1 });
    await cache.get('k1', fetch);
    cache.clear();
    await cache.get('k1', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function fakeContext(user: any) {
  const state: Record<string, any> = { user };
  return {
    get: (k: string) => state[k],
    json: vi.fn((body: any, status: number) => ({ body, status })),
  } as any;
}

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    const c = { req: { header: () => 'Bearer abc123' } } as any;
    expect(extractBearerToken(c)).toBe('abc123');
  });

  it('returns null when there is no Authorization header', () => {
    const c = { req: { header: () => undefined } } as any;
    expect(extractBearerToken(c)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    const c = { req: { header: () => 'Basic abc123' } } as any;
    expect(extractBearerToken(c)).toBeNull();
  });
});

describe('requireCheck', () => {
  it('returns 401 when there is no user on context', async () => {
    const c = fakeContext(null);
    const next = vi.fn();
    await requireCheck(() => true)(c, next);
    expect(c.json).toHaveBeenCalledWith({ success: false, message: 'Authentication required' }, 401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the predicate fails', async () => {
    const c = fakeContext({ is_admin: false });
    const next = vi.fn();
    await requireCheck((u) => u.is_admin, 'Admin access required')(c, next);
    expect(c.json).toHaveBeenCalledWith({ success: false, message: 'Admin access required' }, 403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the predicate passes', async () => {
    const c = fakeContext({ is_admin: true });
    const next = vi.fn();
    await requireCheck((u) => u.is_admin)(c, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(c.json).not.toHaveBeenCalled();
  });
});

describe('canImpersonate', () => {
  const allowed = ['emilguirguis@yahoo.com', 'jen@tbwcinc.com'];

  it('allows every email on the list', () => {
    expect(canImpersonate(allowed, 'emilguirguis@yahoo.com')).toBe(true);
    expect(canImpersonate(allowed, 'jen@tbwcinc.com')).toBe(true);
  });

  it('matches case- and whitespace-insensitively (Supabase emails vary in case)', () => {
    expect(canImpersonate(allowed, 'Jen@TBWCinc.com')).toBe(true);
    expect(canImpersonate(allowed, '  emilguirguis@yahoo.com  ')).toBe(true);
  });

  it('denies anyone not on the list, admin or not', () => {
    expect(canImpersonate(allowed, 'someone.else@tbwcinc.com')).toBe(false);
  });

  it('denies a missing/empty caller email rather than defaulting open', () => {
    expect(canImpersonate(allowed, undefined)).toBe(false);
    expect(canImpersonate(allowed, null)).toBe(false);
    expect(canImpersonate(allowed, '')).toBe(false);
  });

  it('denies everyone when the list is empty (the per-app opt-out)', () => {
    expect(canImpersonate([], 'emilguirguis@yahoo.com')).toBe(false);
  });

  it('never substring-matches a longer address', () => {
    expect(canImpersonate(allowed, 'jen@tbwcinc.com.attacker.test')).toBe(false);
  });
});
