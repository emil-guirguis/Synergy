/**
 * Lightweight "who can I share this with" lookup — unlike routes/users.ts
 * (admin-only end to end, full profile CRUD), this is open to any
 * authenticated user and returns only what a recipient picker needs: id,
 * display name, and sales rep code for disambiguation. No contact info, no
 * role/permission data.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

app.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10) || 10, 25);
  const callerId = c.get('userId');

  const params: any[] = [callerId];
  let where = 'u.approved AND u.locked_at IS NULL AND u.id != $1';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR sr.initial ILIKE $${params.length})`;
  }
  params.push(limit);

  const { rows } = await execQuery(
    c.env,
    `SELECT u.id, u.first_name, u.last_name, sr.initial AS sales_rep_initial
       FROM public.users u
       LEFT JOIN public.qb_sales_rep sr ON sr.qb_sales_rep_id = u.qb_sales_rep_id
      WHERE ${where}
      ORDER BY u.first_name, u.last_name
      LIMIT $${params.length}`,
    params,
    'people.search'
  );

  return c.json({
    success: true,
    data: rows.map((r: any) => ({
      id: r.id,
      label: [r.first_name, r.last_name].filter(Boolean).join(' ') + (r.sales_rep_initial ? ` (${r.sales_rep_initial})` : ''),
    })),
  });
});

export default app;
