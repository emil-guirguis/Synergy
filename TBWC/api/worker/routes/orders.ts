/**
 * Orders — backed by public.qb_sales_order (PK qb_sales_order_id), the QB-synced
 * staging table. Rows are created/removed by the QuickBooks sync only, so there
 * is no POST/DELETE here; PUT updates just the TBWC-owned columns (the QB-owned
 * ones would be clobbered by the next sync anyway).
 * Visibility mirrors the tbwc RLS intent (enforced here since the Worker
 * connects at service level and bypasses RLS):
 *   - admins / can_see_orders  -> every order
 *   - everyone else (a rep)    -> only their own (rep_id = user.id)
 * Writes are admin-only.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';
import { findAll, findById, update, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { orderSchema } from './orderSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'qb_sales_order';
const PK = 'qb_sales_order_id';
// orderSchema.defaultSortBy is "field" or "field asc"/"field desc" — split it
// once here so /GET can fall back to both sortBy and sortOrder from one source.
// Note: defineSchema()'s return only flattens schema/formFields/entityFields/
// relationships/deleteRestrictions onto itself — defaultSortBy (like tableName,
// idFieldName, etc.) stays nested under `.schema`.
const [DEFAULT_SORT_FIELD, DEFAULT_SORT_ORDER] = orderSchema.schema.defaultSortBy.split(/\s+/);
const SEARCH = ['customer_name', 'ref_number', 'invoice_number', 'po_number'];
// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — 'invoice_status' is a fixed-options select, exact-match).
const LIKE_FIELDS = likeFieldsFromSchema(orderSchema);

// sales_rep is synced straight off SalesRepRef.FullName, which QB actually
// populates with the rep's short Initial code (e.g. "POL"), not their name.
// Join qb_sales_rep by list_id to surface the real name instead; a correlated
// subquery (rather than crud.ts's `joins` option) keeps this working for both
// findAll and findById, and falls back to the raw synced value for any order
// whose rep isn't in qb_sales_rep (deleted rep, or not yet synced).
const SELECT_WITH_REP_NAME =
  `"${TABLE}".*, COALESCE(` +
  `(SELECT qsr.name FROM public.qb_sales_rep qsr WHERE qsr.list_id = "${TABLE}".sales_rep_list_id), ` +
  `"${TABLE}".sales_rep) AS sales_rep`;

// The only columns a PUT may touch — everything else on qb_sales_order is
// QB-owned (overwritten by sync) or maintained by refreshOrderInvoiceStatus().
// commission_total is a Postgres GENERATED column (commission + overage) —
// deliberately excluded here; the DB itself rejects a direct write to it.
const WRITABLE = new Set([
  'build_notes',
  'notes',
  'expedite',
  'jay',
  'ship_no_later_than',
  'sold_for',
  'd_net_cost',
  'overage',
  'commission',
  'project_admin_fee',
  'trade_ally_fee',
  'rep_id',
]);

function canSeeAll(user: any): boolean {
  return !!(user?.is_admin || user?.can_see_orders);
}

app.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  // missingPo/notShipped are synthetic filters (dashboard alert cards), not real
  // columns — keep them out of whereFromQuery's generic pass and apply as
  // IS NULL checks below instead. "Not invoiced" needs no such special-casing —
  // is_fully_invoiced is a real column with its own schema-generated filter, so
  // ?is_fully_invoiced=false already flows through whereFromQuery normally.
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS, extraReserved: ['missingPo', 'notShipped'] });
  // Field filters first, then the security scope — rep_id always wins so a rep
  // can't widen their own visibility via a crafted query param.
  const where: Record<string, any> = { ...fieldWhere, ...(canSeeAll(user) ? {} : { rep_id: user.id }) };
  if (q.missingPo === 'true') where.po_number = null;
  if (q.notShipped === 'true') where.shipped_date = null;
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    // Default sort (SO # desc) comes from the schema — orderSchema.defaultSortBy —
    // so it's controlled in one place rather than hardcoded here.
    sortBy: q.sortBy || DEFAULT_SORT_FIELD,
    sortOrder: q.sortOrder || DEFAULT_SORT_ORDER,
    where,
    whereLike,
    selectFields: SELECT_WITH_REP_NAME,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'), undefined, SELECT_WITH_REP_NAME);
  if (!row) return c.json({ success: false, message: 'Order not found' }, 404);
  if (!canSeeAll(user) && row.rep_id !== user.id) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  return c.json({ success: true, data: row });
});

app.put('/:id', requireAdmin, async (c) => {
  const body = await c.req.json();
  const data: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (WRITABLE.has(k)) data[k] = v;
  }
  if (Object.keys(data).length === 0) {
    return c.json({ success: false, message: 'No editable fields in request' }, 400);
  }
  // qb_sales_order has no updated_at column.
  const row = await update(c.env, TABLE, PK, c.req.param('id'), data, { touchUpdatedAt: false });
  if (!row) return c.json({ success: false, message: 'Order not found or nothing to update' }, 404);
  return c.json({ success: true, data: row });
});

// Orders exist only via the QuickBooks sync — no manual create/delete.
app.post('/', requireAdmin, (c) =>
  c.json({ success: false, message: 'Orders are created by the QuickBooks sync and cannot be created here.' }, 405));
app.delete('/:id', requireAdmin, (c) =>
  c.json({ success: false, message: 'Orders are managed by the QuickBooks sync and cannot be deleted here.' }, 405));

export default app;
