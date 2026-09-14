/**
 * Users CRUD (admin-only). Table public.users, PK id (uuid).
 * Envelope matches the framework store: list -> {data:{items,total}}, single -> {data}.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { findAll, findById, create, update, remove, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { usersSchema } from './usersSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// The Users module is admin-only end to end.
app.use('*', authenticateToken);

const TABLE = 'users';
const PK = 'id';
const SEARCH = ['first_name', 'last_name', 'email', 'agency_name'];
// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — e.g. 'type' is excluded, it's an exact-match select).
const LIKE_FIELDS = likeFieldsFromSchema(usersSchema);

/** The QB sales-rep dropdown posts '' when unset; a bigint FK needs null, not ''. */
function normalize(body: Record<string, any>): Record<string, any> {
  if (body.qb_sales_rep_id === '') body.qb_sales_rep_id = null;
  return body;
}

app.get('/', requirePermission('user:read'), async (c) => {
  const q = c.req.query();
  const { where, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS });
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    where,
    whereLike,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', requirePermission('user:read'), async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'User not found' }, 404);
  return c.json({ success: true, data: row });
});

app.post('/', requirePermission('user:write'), async (c) => {
  const body = normalize(await c.req.json());
  const row = await create(c.env, TABLE, body);
  return c.json({ success: true, data: row }, 201);
});

app.put('/:id', requirePermission('user:write'), async (c) => {
  const body = normalize(await c.req.json());
  // public.users has no updated_at column.
  const row = await update(c.env, TABLE, PK, c.req.param('id'), body, { touchUpdatedAt: false });
  if (!row) return c.json({ success: false, message: 'User not found or nothing to update' }, 404);
  return c.json({ success: true, data: row });
});

app.delete('/:id', requirePermission('user:write'), async (c) => {
  const row = await remove(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'User not found' }, 404);
  return c.json({ success: true, data: row });
});

export default app;
