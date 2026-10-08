/**
 * Auth routes. Login itself is done client-side via the Supabase Auth REST API;
 * this only exposes the authenticated caller's tbwc profile.
 * GET /api/auth/me -> { success: true, data: <user profile> }
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, invalidateProfile, loadProfile, permissionsFor } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

// Resolved grants ride along so the frontend can gate on scope (e.g. an
// order:read=all rep role) instead of hardcoding is_admin — see the
// PermissionSet.list() doc comment in framework permissions.ts.
app.get('/me', async (c) => {
  const set = await permissionsFor(c.env, c.get('user'));
  return c.json({ success: true, data: { ...c.get('user'), permissions: set.list() } });
});

// Self-service display preference overrides (Settings > System Config sets
// the org default; this lets any authenticated user override it for
// themselves — e.g. a rep in a different timezone than head office). `null`
// clears the override back to the org default. currency is not here — it's
// deliberately org-only, not a per-viewer preference.
const TIME_FORMATS = new Set(['12h', '24h']);
app.put('/me/preferences', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, string | number | null> = {};

  if ('timezone' in body) updates.timezone = body.timezone || null;
  if ('date_format' in body) updates.date_format = body.date_format || null;
  if ('time_format' in body) {
    if (body.time_format !== null && !TIME_FORMATS.has(body.time_format)) {
      return c.json({ success: false, message: "time_format must be '12h', '24h', or null" }, 400);
    }
    updates.time_format = body.time_format || null;
  }
  if ('default_page_size' in body) {
    const n = body.default_page_size === null ? null : Number(body.default_page_size);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 100)) {
      return c.json({ success: false, message: 'default_page_size must be an integer between 1 and 100, or null' }, 400);
    }
    updates.default_page_size = n;
  }

  const fields = Object.keys(updates);
  if (fields.length === 0) {
    return c.json({ success: false, message: 'No fields to update' }, 400);
  }

  const userId = c.get('userId');
  const setClause = fields.map((key, i) => `${key} = $${i + 1}`).join(', ');
  await execQuery(
    c.env,
    `UPDATE public.users SET ${setClause} WHERE id = $${fields.length + 1}`,
    [...fields.map((key) => updates[key]), userId],
    'auth.updatePreferences'
  );

  invalidateProfile(userId);
  const profile = await loadProfile(c.env, userId);
  const set = await permissionsFor(c.env, profile);
  return c.json({ success: true, data: { ...profile, permissions: set.list() } });
});

export default app;
