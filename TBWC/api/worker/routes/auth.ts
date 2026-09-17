/**
 * Auth routes. Login itself is done client-side via the Supabase Auth REST API;
 * this only exposes the authenticated caller's tbwc profile.
 * GET /api/auth/me -> { success: true, data: <user profile> }
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, permissionsFor } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

// Resolved grants ride along so the frontend can gate on scope (e.g. an
// order:read=all rep role) instead of hardcoding is_admin — see the
// PermissionSet.list() doc comment in framework permissions.ts.
app.get('/me', async (c) => {
  const set = await permissionsFor(c.env, c.get('user'));
  return c.json({ success: true, data: { ...c.get('user'), permissions: set.list() } });
});

export default app;
