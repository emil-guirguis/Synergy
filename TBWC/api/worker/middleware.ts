/**
 * Auth middleware for the TBWC Worker.
 * Validates the Supabase access token, loads the caller's tbwc profile,
 * and exposes both on the Hono context.
 */
import { Context, Next } from 'hono';
import { Env, execQuery } from './db';
import { verifySupabaseToken } from './supabaseVerify';
import { checkRateLimit, createEntityCache, extractBearerToken, requireCheck } from '@meterit/framework-backend/api/base/auth';

export type AuthVariables = {
  userId: string;
  user: any;
  requestId: string;
};

// Short-lived isolate cache of tbwc profiles keyed by user id; de-dupes
// concurrent lookups for the same user instead of each firing its own query.
const PROFILE_TTL_MS = 60_000;
const profileCache = createEntityCache<any>(PROFILE_TTL_MS);

export async function loadProfile(env: Env, userId: string): Promise<any | null> {
  return profileCache.get(userId, async () => {
    // LEFT JOIN qb_sales_rep so a rep's own QB rep identity (list_id, used by
    // the order list's rep filter) travels with their profile — lets the
    // frontend default/lock that filter to "them" without a second lookup.
    const result = await execQuery(
      env,
      `SELECT u.id, u.email, u.first_name, u.last_name, u.agency_name, u.url, u.title, u.work_phone, u.ext, u.mobile,
              u.addr1, u.addr2, u.city, u.state, u.postal, u.about, u.approved, u.is_admin, u.type,
              u.can_see_orders, u.can_approve_rep_leads, u.created_at, u.locked_at, u.last_verified_at,
              u.qb_sales_rep_id, sr.list_id AS sales_rep_list_id, sr.initial AS sales_rep_initial, sr.name AS sales_rep_name
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
