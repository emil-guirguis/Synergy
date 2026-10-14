/**
 * "Manages" relation (public.user_manager, see migrations/061-user-manager.sql) —
 * flat, one level: a manager sees their own orders plus every user they manage's
 * orders (routes/orders.ts ownOnly scoping unions sales_rep_list_id across the
 * set). The Users form's "Manages" grid, as a child-row resource:
 *
 *   GET    /:managerId        -> rows (userGridManager:read)
 *   POST   /:managerId        -> add  (userGridManager:create)
 *   DELETE /:managerId/:id    -> remove (userGridManager:delete)
 *
 * Schema: userGridManagerSchema.ts; CRUD: framework childRows.ts. Own-scoped
 * grants only reach the caller's own manager row set.
 */
import { Hono } from 'hono';
import { Env, execQuery, withTransaction } from '../db';
import { AuthVariables, authenticateToken, requirePermission, clearProfileCache } from '../middleware';
import {
  listChildren, createChild, deleteChild,
  ChildRowNotFoundError, ChildRowValidationError, ChildRowConflictError, type ChildRowsConfig,
} from '@meterit/framework-backend/api/base/childRows';
import { userGridManagerSchema } from './userGridManagerSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const CONFIG: ChildRowsConfig = {
  schema: userGridManagerSchema,
  // The managed user's name/email/rep code, so the grid has something to show
  // without a second round trip per row.
  select: {
    columns: `t.*, concat_ws(' ', u.first_name, u.last_name) AS managed_user_name, u.email, sr.initial AS sales_rep_initial`,
    joins: `JOIN public.users u ON u.id = t.managed_user_id
            LEFT JOIN public.qb_sales_rep sr ON sr.qb_sales_rep_id = u.qb_sales_rep_id`,
    orderBy: 'u.first_name, u.last_name',
  },
  prepare: (row, _q, managerId) => {
    if (!row.managed_user_id) throw new ChildRowValidationError('Pick a user');
    if (String(row.managed_user_id) === String(managerId)) throw new ChildRowValidationError('A user cannot manage themselves');
    return row;
  },
  // The managed set feeds loadProfile's per-isolate cache (middleware.ts) —
  // drop it so the next request for either user picks up the change.
  afterChange: async () => { clearProfileCache(); },
};

/** Own-scoped grants only reach the caller's own "Manages" list. */
function canReach(c: any, permission: string): boolean {
  return c.get('permissions').scopeOf(permission) !== 'own' || c.get('user')?.id === c.req.param('managerId');
}

function rowError(c: any, err: unknown) {
  if (err instanceof ChildRowNotFoundError) return c.json({ success: false, message: 'Not found' }, 404);
  if (err instanceof ChildRowValidationError) return c.json({ success: false, message: err.message }, 400);
  if (err instanceof ChildRowConflictError) return c.json({ success: false, message: 'Already managing this user' }, 409);
  // FK violation: manager or managed user doesn't exist.
  if ((err as any)?.code === '23503') return c.json({ success: false, message: 'Unknown user' }, 404);
  throw err;
}

app.get('/:managerId', requirePermission('userGridManager:read'), async (c) => {
  if (!canReach(c, 'userGridManager:read')) return c.json({ success: false, message: 'Not found' }, 404);
  const items = await listChildren(execQuery, c.env, CONFIG, c.req.param('managerId'));
  return c.json({ success: true, data: { items } });
});

app.post('/:managerId', requirePermission('userGridManager:create'), async (c) => {
  if (!canReach(c, 'userGridManager:create')) return c.json({ success: false, message: 'Not found' }, 404);
  try {
    const { row } = await createChild(withTransaction, c.env, CONFIG, c.req.param('managerId'), await c.req.json().catch(() => ({})));
    return c.json({ success: true, data: { item: row } }, 201);
  } catch (err) {
    return rowError(c, err);
  }
});

app.delete('/:managerId/:id', requirePermission('userGridManager:delete'), async (c) => {
  if (!canReach(c, 'userGridManager:delete')) return c.json({ success: false, message: 'Not found' }, 404);
  try {
    await deleteChild(withTransaction, c.env, CONFIG, c.req.param('managerId'), c.req.param('id'));
    return c.json({ success: true, data: {} });
  } catch (err) {
    return rowError(c, err);
  }
});

export default app;
