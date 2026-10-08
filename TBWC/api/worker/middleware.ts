/**
 * Auth middleware for the TBWC Worker.
 * Validates the Supabase access token, loads the caller's tbwc profile,
 * and exposes both on the Hono context.
 */
import { Context, Next } from 'hono';
import { Env, execQuery } from './db';
import { verifySupabaseToken } from './supabaseVerify';
import { checkRateLimit, createEntityCache, extractBearerToken, requireCheck } from '@meterit/framework-backend/api/base/auth';
import {
  createPermissions,
  createRequirePermission,
  type PermissionSet,
} from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from './permissions';

export type AuthVariables = {
  userId: string;
  user: any;
  permissions: PermissionSet;
  requestId: string;
};

// Short-lived isolate cache of tbwc profiles keyed by user id; de-dupes
// concurrent lookups for the same user instead of each firing its own query.
const PROFILE_TTL_MS = 60_000;
const profileCache = createEntityCache<any>(PROFILE_TTL_MS);

/** Call after a self-service profile update so the next loadProfile() re-fetches. */
export function invalidateProfile(userId: string): void {
  profileCache.delete(userId);
}

export async function loadProfile(env: Env, userId: string): Promise<any | null> {
  return profileCache.get(userId, async () => {
    // LEFT JOIN qb_sales_rep so a rep's own QB rep identity (list_id, used by
    // the order list's rep filter) travels with their profile — lets the
    // frontend default/lock that filter to "them" without a second lookup.
    const result = await execQuery(
      env,
      // role_id falls back to the role matching users.type when the column is
      // unset. Users arrive through more than one path (admin create, Supabase
      // signup), and a user with no role resolves to no permissions at all —
      // i.e. locked out of the whole app. Resolving it here keeps that from
      // depending on every creation path remembering to set it.
      `SELECT u.id, u.email, u.first_name, u.last_name, u.agency_name, u.url, u.title, u.work_phone, u.ext, u.mobile,
              u.addr1, u.addr2, u.city, u.state, u.postal, u.about, u.approved, u.is_admin, u.type,
              u.created_at, u.locked_at, u.last_verified_at,
              u.permission_overrides,
              COALESCE(u.role_id, (
                SELECT r.role_id FROM public.role r
                 WHERE r.tenant_id IS NULL
                   AND r.code = CASE WHEN u.is_admin THEN 'admin'
                                     WHEN u.type IN ('employee', 'rep', 'customer') THEN u.type
                                     ELSE 'rep' END
              )) AS role_id,
              u.qb_sales_rep_id, sr.list_id AS sales_rep_list_id, sr.initial AS sales_rep_initial, sr.name AS sales_rep_name,
              -- Flat "manages" relation (public.user_manager) — the QB rep
              -- list_ids of every user this one manages, for orders.ts's
              -- ownOnly scoping to union against. Empty array, not null, when
              -- unset so callers can spread it without a guard.
              COALESCE((
                SELECT array_agg(msr.list_id) FROM public.user_manager um
                JOIN public.qb_sales_rep msr ON msr.qb_sales_rep_id = (
                  SELECT mu.qb_sales_rep_id FROM public.users mu WHERE mu.id = um.managed_user_id
                )
                WHERE um.manager_id = u.id
              ), ARRAY[]::text[]) AS managed_sales_rep_list_ids,
              -- Settings > System Config's org-wide defaults, overridable per-user
              -- (public.users.timezone/date_format/time_format/default_page_size,
              -- NULL = inherit). company_settings is a singleton row, same org-wide
              -- fallback for every user. currency is deliberately org-only (no
              -- per-user override — see numberHelpers.ts's formatCurrency).
              COALESCE(u.default_page_size, (SELECT cs.default_page_size FROM public.company_settings cs LIMIT 1)) AS default_page_size,
              COALESCE(u.timezone, (SELECT cs.timezone FROM public.company_settings cs LIMIT 1)) AS timezone,
              COALESCE(u.date_format, (SELECT cs.date_format FROM public.company_settings cs LIMIT 1)) AS date_format,
              COALESCE(u.time_format, (SELECT cs.time_format FROM public.company_settings cs LIMIT 1)) AS time_format,
              (SELECT cs.currency FROM public.company_settings cs LIMIT 1) AS currency
       FROM public.users u
       LEFT JOIN public.qb_sales_rep sr ON sr.qb_sales_rep_id = u.qb_sales_rep_id
       WHERE u.id = $1`,
      [userId],
      'loadProfile'
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  });
}

export async function authenticateToken(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  next: Next
): Promise<Response | void> {
  const token = extractBearerToken(c);
  if (!token) return c.json({ success: false, message: 'Access token required' }, 401);

  const verified = await verifySupabaseToken(c.env, token);
  if (!verified) {
    // Throttle repeated failed verifications per IP — slows token-guessing/
    // credential-stuffing against every authenticated route (TBWC had no rate
    // limiting anywhere before this; MeterItPro throttles at its login route,
    // TBWC has no login route of its own since Supabase Auth is called
    // directly from the frontend, so this is the equivalent choke point).
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    if (!checkRateLimit(`rl:authfail:${ip}`, 30, 60_000)) {
      return c.json({ success: false, message: 'Too many failed attempts, please try again later' }, 429);
    }
    return c.json({ success: false, message: 'Invalid or expired token' }, 401);
  }

  const profile = await loadProfile(c.env, verified.userId);
  if (!profile) return c.json({ success: false, message: 'No user profile found' }, 403);
  if (!profile.approved) return c.json({ success: false, message: 'Account pending approval' }, 403);
  if (profile.locked_at) {
    return c.json({ success: false, message: 'Account locked — check your email to re-verify.' }, 403);
  }

  c.set('userId', verified.userId);
  c.set('user', profile);
  await next();
}

/** Guard that requires the caller to be an admin (is_admin). */
export const requireAdmin = requireCheck((user) => !!user?.is_admin, 'Admin access required');

/**
 * Every QB sales-rep list_id this caller may see rows for under an "own"
 * scope: their own linked rep, plus every user they manage (flat, one level —
 * public.user_manager, baked into managed_sales_rep_list_ids above). Shared
 * by orders.ts/quotes.ts/invoices.ts so a manager's own-scope visibility
 * means the same thing everywhere rather than three hand-copied versions
 * drifting apart. Empty when unlinked and managing nobody, so the caller
 * matches zero rows rather than falling through to "every unassigned row"
 * the way an `IS NULL` scope would.
 */
export function visibleRepListIds(user: any): string[] {
  return [user.sales_rep_list_id, ...(user.managed_sales_rep_list_ids ?? [])].filter(Boolean);
}

// TBWC is single-tenant, so every role here is a system role (tenant_id NULL)
// and the profile carries no tenant_id — the framework's tenant guard then
// admits exactly the system roles, which is what we want.
const permissions = createPermissions(execQuery);

export function clearPermissionCache(): void {
  permissions.clearCache();
}

// userManagers.ts calls this after add/remove — a manager's managed-reps list
// (sales_rep_list_id set, used by orders.ts ownOnly scoping) is baked into the
// profile at loadProfile() time, so a stale cached profile would hide the
// change for up to PROFILE_TTL_MS.
export function clearProfileCache(): void {
  profileCache.clear();
}

/** Resolve the caller's permissions. Cached per role inside the framework. */
export async function permissionsFor(env: Env, user: any): Promise<PermissionSet> {
  return permissions.resolveFor(env, user, PERMISSIONS);
}

/**
 * Route guard: `app.get('/', requirePermission('order:read'), handler)`.
 * Parks the resolved set on the context as `permissions`, so handlers can read
 * scope and hidden fields without resolving again.
 */
export const requirePermission = createRequirePermission((c: any) =>
  permissionsFor(c.env, c.get('user'))
);
