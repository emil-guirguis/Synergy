/**
 * Customers (QuickBooks) — read-only. Table public.qb_customer, PK qb_customer_id.
 * Populated by the QBWC pull (CustomerQueryRq); the source of truth is QuickBooks,
 * so this module exposes list + detail only. No writes: edits here would be
 * clobbered on the next sync, and QB push-back is an unbuilt stub.
 * Admin-only.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { customersSchema } from './customersSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('customer:read'));

const TABLE = 'qb_customer';
const PK = 'qb_customer_id';
const SEARCH = ['full_name', 'company_name', 'email', 'phone'];
// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — 'is_active' is boolean, so it's exact-match).
const LIKE_FIELDS = likeFieldsFromSchema(customersSchema);

app.get('/', async (c) => {
  const q = c.req.query();
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS });
  // Hidden by default (CustomerQueryRq pulls ActiveStatus=All so counts match QB
  // and status flips keep syncing — see qbwc/objects/customer.ts). fieldWhere's
  // own is_active (an explicit ?is_active=false filter) still wins.
  // Deleted in QB (see qbwc/objects/listDeleted.ts) — the row is kept so history
  // that points at it still resolves, but it must never list as a live customer.
  const where: Record<string, any> = { is_active: true, ...fieldWhere, qb_deleted_at: null };
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    orderBy: q.sortBy ? undefined : `"${TABLE}".full_name ASC`,
    where,
    whereLike,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row || row.qb_deleted_at) return c.json({ success: false, message: 'Customer not found' }, 404);
  return c.json({ success: true, data: row });
});

export default app;
