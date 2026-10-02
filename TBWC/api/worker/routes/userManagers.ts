/**
 * "Manages" relation (public.user_manager, see migrations/061-user-manager.sql) —
 * flat, one level: a manager sees their own orders plus every user they manage's
 * orders (routes/orders.ts ownOnly scoping unions sales_rep_list_id across the
 * set). Configured only from the Users form's "Manages" tab, so this reuses
 * that module's existing admin-only permissions (user:read/user:write) rather
 * than introducing a new one.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission, clearProfileCache } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'user_manager';
const PK = 'user_manager_id';

// Joined with the managed user's own name/email so the grid has something to
// show without a second round trip per row.
const SELECT_WITH_USER = `
  um.user_manager_id, um.manager_id, um.managed_user_id, um.created_at,
  u.first_name, u.last_name, u.email
`;

app.get('/', requirePermission('user:read'), async (c) => {
  const managerId = c.req.query('manager_id');
  if (!managerId) return c.json({ success: false, message: 'manager_id is required' }, 400);
  const { rows } = await execQuery(
    c.env,
    `SELECT ${SELECT_WITH_USER}
       FROM public.${TABLE} um
       JOIN public.users u ON u.id = um.managed_user_id
      WHERE um.manager_id = $1
      ORDER BY u.first_name, u.last_name`,
    [managerId],
    'userManagers.list'
  );
  return c.json({ success: true, data: { items: rows, total: rows.length } });
});

app.post('/', requirePermission('user:write'), async (c) => {
  const body = await c.req.json();
  const { manager_id, managed_user_id } = body;
  if (!manager_id || !managed_user_id) {
    return c.json({ success: false, message: 'manager_id and managed_user_id are required' }, 400);
  }
  if (manager_id === managed_user_id) {
    return c.json({ success: false, message: 'A user cannot manage themselves' }, 400);
  }
  try {
    const { rows } = await execQuery(
      c.env,
      `INSERT INTO public.${TABLE} (manager_id, managed_user_id) VALUES ($1, $2) RETURNING ${PK}`,
      [manager_id, managed_user_id],
      'userManagers.create'
    );
    // The managed set feeds loadProfile's per-isolate cache (middleware.ts) —
    // drop it so the next request for either user picks up the change.
    clearProfileCache();
    const { rows: withUser } = await execQuery(
      c.env,
      `SELECT ${SELECT_WITH_USER} FROM public.${TABLE} um JOIN public.users u ON u.id = um.managed_user_id WHERE um.${PK} = $1`,
      [rows[0][PK]],
      'userManagers.createJoined'
    );
    return c.json({ success: true, data: withUser[0] }, 201);
  } catch (e: any) {
    // unique_violation — already managing this user.
    if (e?.code === '23505') {
      return c.json({ success: false, message: 'Already managing this user' }, 409);
    }
    throw e;
  }
});

app.delete('/:id', requirePermission('user:write'), async (c) => {
  const { rows } = await execQuery(
    c.env,
    `DELETE FROM public.${TABLE} WHERE ${PK} = $1 RETURNING ${PK}`,
    [c.req.param('id')],
    'userManagers.delete'
  );
  if (!rows.length) return c.json({ success: false, message: 'Not found' }, 404);
  clearProfileCache();
  return c.json({ success: true, message: 'Removed' });
});

export default app;
