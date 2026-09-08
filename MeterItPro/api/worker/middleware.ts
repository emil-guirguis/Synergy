/**
 * Shared middleware for Cloudflare Worker
 * JWT auth, tenant context, and permission checks.
 */

import { Context, Next } from 'hono';
import { verify } from 'hono/jwt';
import { execQuery, Env } from './db';
import { checkRateLimit, ipRateLimit, createEntityCache, extractBearerToken } from '@meterit/framework-backend/api/base/auth';

export { ipRateLimit };

// Module-level cache shared within a Worker isolate. Avoids a DB round-trip on
// every authenticated request when the same user fires multiple parallel API
// calls (e.g., on page load), and de-dupes concurrent fetches on a cold cache.
const USER_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const userCache = createEntityCache<any>(USER_CACHE_TTL_MS);

export function clearUserCache(): void {
  userCache.clear();
}

export async function getCachedUser(env: Env, userId: string): Promise<any | null> {
  return userCache.get(userId, async () => {
    const result = await execQuery(
      env,
      `SELECT users_id, name, email, phone, role, active, tenant_id, permissions, is_super_admin, is_support_admin
       FROM users WHERE users_id = $1`,
      [userId],
      'getCachedUser'
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  });
}

// Hono context variables set by middleware
export type AuthVariables = {
  user: any;
  tenantId: number;
  requestId: string;
};

/**
 * JWT authentication middleware
 *
 * Validates the token and sets context from JWT claims only — no DB query.
 * Both userId and tenant_id are embedded in the token at sign time, so polling
 * endpoints like /notifications/count never touch the users table.
 *
 * The DB lookup (cached) is deferred to requirePermission(), which is the only
 * place that actually needs role and permissions.
 */
export async function authenticateToken(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next): Promise<Response | void> {
  const token = extractBearerToken(c);

  if (!token) {
    return c.json({ success: false, message: 'Access token required' }, 401);
  }

  let decoded: any;
  try {
    decoded = await verify(token, c.env.JWT_SECRET, 'HS256');
  } catch (err: any) {
    if (err.name === 'JwtTokenExpired') {
      // Expired tokens are validly signed — a stale tab, not an attack.
      // Don't count them toward the throttle or we'd 429 legit users.
      return c.json({ success: false, message: 'Token expired' }, 401);
    }
    // Throttle repeated invalid-signature failures per IP — slows token
    // guessing against every authenticated route (login/signup already have
    // their own ipRateLimit; this is the choke point for forged bearers).
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    if (!checkRateLimit(`rl:authfail:${ip}`, 30, 60_000)) {
      return c.json({ success: false, message: 'Too many failed attempts, please try again later' }, 429);
    }
    return c.json({ success: false, message: 'Invalid token' }, 401);
  }

  if (!decoded.userId || !decoded.tenant_id) {
    return c.json({ success: false, message: 'Invalid token - missing claims' }, 401);
  }

  // Minimal user object from JWT claims — no DB round-trip.
  // Routes that need full user data (role, permissions, name, email) call
  // requirePermission(), which does the cached DB lookup lazily.
  c.set('user', {
    users_id: decoded.userId,
    tenant_id: decoded.tenant_id,
    isAdminView: decoded.isAdminView || false,
    viewingTenantName: decoded.viewingTenantName || null,
  });
  c.set('tenantId', decoded.tenant_id);
  await next();
}

/**
 * Permission check middleware factory.
 * Usage: requirePermission('meter:read')
 *
 * This is where the DB lookup happens — lazily and cached. Routes that don't
 * call requirePermission() never hit the users table.
 */
export function requirePermission(permission: string) {
  return async (c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) => {
    const partial = c.get('user');
    if (!partial) {
      return c.json({ success: false, message: 'Authentication required' }, 401);
    }

    // Load full user (cached) to get role, permissions, and active flag.
    // Skip if user is already fully loaded (has role set).
    let user: any;
    if (partial.role !== undefined) {
      user = partial;
    } else {
      try {
        user = await getCachedUser(c.env, String(partial.users_id));
        if (!user) {
          return c.json({ success: false, message: 'User not found' }, 401);
        }
      } catch (e) {
        console.error('[AUTH] User lookup error in requirePermission:', e);
        return c.json({ success: false, message: 'Failed to verify user' }, 500);
      }
      if (!user.active) {
        return c.json({ success: false, message: 'Account is inactive' }, 401);
      }
      // Promote context to full user so downstream handlers can read name/email/etc.
      c.set('user', user);
    }

    // Super admin and admin bypass permission checks
    if (user.is_super_admin || user.role === 'admin') {
      return next();
    }

    // Parse permission string like "meter:read"
    const [module, action] = permission.split(':');
    const perms = user.permissions;

    // Handle array format: ["dashboard:read", "meter:read"]
    if (Array.isArray(perms)) {
      if (perms.includes(permission)) {
        return next();
      }
    }
    // Handle nested object format: { dashboard: { read: true } }
    else if (perms && typeof perms === 'object' && perms[module] && perms[module][action]) {
      return next();
    }

    return c.json({ success: false, message: 'Insufficient permissions' }, 403);
  };
}

// Sync servers poll constantly with the same key; cache the key→tenant lookup
// so each poll doesn't cost a DB round-trip. Short TTL bounds how long a
// revoked/deactivated key keeps working. Misses (invalid keys) are not cached,
// but the per-key rate limit above caps how hard they can hit the DB.
const SYNC_KEY_TTL_MS = 60_000;
const syncTenantCache = createEntityCache<{ tenant_id: number }>(SYNC_KEY_TTL_MS);

export function clearSyncTenantCache(): void {
  syncTenantCache.clear();
}

/**
 * API key authentication for sync routes.
 */
export async function authenticateSyncServer(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next): Promise<Response | void> {
  const apiKey = c.req.header('x-api-key');
  if (!apiKey) {
    return c.json({ success: false, message: 'API key required' }, 401);
  }

  if (!checkRateLimit(`rl:apikey:${apiKey}`, 100, 60_000)) {
    return c.json({ success: false, message: 'Too many requests' }, 429);
  }

  const tenant = await syncTenantCache.get(apiKey, async () => {
    const result = await execQuery(
      c.env,
      'SELECT tenant_id FROM tenant WHERE api_key = $1 AND active = true',
      [apiKey]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  });

  if (!tenant) {
    return c.json({ success: false, message: 'Invalid API key' }, 401);
  }

  c.set('tenantId', tenant.tenant_id);
  await next();
}
