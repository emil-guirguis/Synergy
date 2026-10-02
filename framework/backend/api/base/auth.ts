/**
 * Shared auth/security primitives for Hono worker routes — the framework-shared
 * implementation. Every consuming app's local worker/middleware.ts builds its
 * own authenticateToken/requirePermission on top of these:
 *
 *   import { checkRateLimit, ipRateLimit, createEntityCache, extractBearerToken, requireCheck }
 *     from '@meterit/framework-backend/api/base/auth';
 *
 * Token verification itself (JWT vs Supabase REST, etc.) stays app-local since
 * each app's identity provider differs — this covers the mechanics every app
 * needs regardless of provider: pulling the bearer token off the request,
 * throttling by caller IP, and caching a loaded user/profile row without
 * racing duplicate fetches when the cache is cold.
 */
// Deliberately not importing Hono's Context/Next types: each consuming app
// installs its own copy of the `hono` package, so TS treats those installs'
// Context types as nominally distinct even though they're structurally
// identical (a duplicate-package hazard) — a function typed against this
// package's `hono` install fails to satisfy an app's MiddlewareHandler type.
// Minimal duck-typed shapes sidestep that entirely, same as crud.ts's
// ExecQueryFn avoids importing any DB-client-specific type.
interface MinimalContext {
  req: { header(name: string): string | undefined; path: string };
  get(key: string): any;
  json(body: any, status: number): any;
}
type NextFn = () => Promise<any>;

export function extractBearerToken(c: MinimalContext): string | null {
  const authHeader = c.req.header('authorization');
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

// ===== In-isolate rate limiter =====
// Keyed by an arbitrary string (e.g. "rl:<ip>:<path>" or "rl:apikey:<key>").
// Each Worker isolate maintains its own store; good enough for brute-force protection.
const RATE_LIMIT_MAX_KEYS = 10_000;
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function sweepExpiredRateLimits(): void {
  const now = Date.now();
  for (const [k, v] of rateLimitStore) {
    if (v.resetAt < now) rateLimitStore.delete(k);
  }
}

export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt < now) {
    if (rateLimitStore.size >= RATE_LIMIT_MAX_KEYS) sweepExpiredRateLimits();
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}

/** Rate-limit middleware keyed by caller IP + request path. */
export function ipRateLimit(maxRequests: number, windowMs: number) {
  return async (c: MinimalContext, next: NextFn) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const key = `rl:${ip}:${c.req.path}`;
    if (!checkRateLimit(key, maxRequests, windowMs)) {
      return c.json({ success: false, message: 'Too many requests, please try again later' }, 429);
    }
    return next();
  };
}

// ===== Cached entity loader with in-flight de-dup =====
// Every app loads a "current user" row on auth and wants to avoid a DB
// round-trip per request without racing duplicate fetches when several
// requests for the same key land while the cache is cold (e.g. page load
// firing several parallel API calls).
export interface EntityCache<T> {
  get(key: string, fetch: () => Promise<T | null>): Promise<T | null>;
  clear(): void;
}

export function createEntityCache<T>(ttlMs: number, maxKeys = 1000): EntityCache<T> {
  const cache = new Map<string, { value: T; expiresAt: number }>();
  const inFlight = new Map<string, Promise<T | null>>();

  function set(key: string, value: T): void {
    if (cache.size >= maxKeys) {
      // Evict oldest insertion (Map preserves insertion order)
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  return {
    async get(key, fetch) {
      const now = Date.now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now) return cached.value;

      const existing = inFlight.get(key);
      if (existing) return existing;

      const promise = fetch()
        .then((value) => {
          inFlight.delete(key);
          if (value !== null) set(key, value);
          return value;
        })
        .catch((err) => {
          inFlight.delete(key);
          throw err;
        });
      inFlight.set(key, promise);
      return promise;
    },
    clear() {
      cache.clear();
      inFlight.clear();
    },
  };
}

// ===== Authorization guard =====
/**
 * Generic 401/403 guard factory. `predicate` reads whatever the app's
 * authenticateToken put in `c.get('user')` (permission strings, an is_admin
 * flag, a role, ...) — each app defines its own predicate to match its own
 * permission model; this just wires the "no user -> 401, fails check -> 403"
 * response contract identically everywhere.
 */
export function requireCheck(predicate: (user: any) => boolean, message = 'Insufficient permissions') {
  return async (c: MinimalContext, next: NextFn) => {
    const user = c.get('user');
    if (!user) return c.json({ success: false, message: 'Authentication required' }, 401);
    if (!predicate(user)) return c.json({ success: false, message }, 403);
    return next();
  };
}

// ===== Dev-only user impersonation gate =====
export interface ImpersonationEnv {
  ENABLE_IMPERSONATION?: string;
  IMPERSONATE_ALLOWED_EMAIL?: string;
}

/**
 * "Log in as this user" gate for local testing — not a role-based admin
 * feature. Both env vars are meant to live only in `.dev.vars`; never
 * `wrangler secret put` them to a deployed Worker, or this opens up in prod
 * too. Each app's impersonate route calls this after resolving the caller's
 * email (role/permission checks, if any, happen separately in that route).
 */
export function canImpersonate(env: ImpersonationEnv, callerEmail?: string | null): boolean {
  return (
    env.ENABLE_IMPERSONATION === 'true' &&
    !!env.IMPERSONATE_ALLOWED_EMAIL &&
    !!callerEmail &&
    callerEmail.toLowerCase() === env.IMPERSONATE_ALLOWED_EMAIL.toLowerCase()
  );
}
