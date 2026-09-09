/**
 * Orders — backed by public.qb_sales_order (PK qb_sales_order_id), the QB-synced
 * staging table. Rows are created/removed by the QuickBooks sync only, so there
 * is no POST/DELETE here; PUT updates just the TBWC-owned columns (the QB-owned
 * ones would be clobbered by the next sync anyway).
 * Visibility mirrors the tbwc RLS intent (enforced here since the Worker
 * connects at service level and bypasses RLS):
 *   - admins                   -> every order
 *   - everyone else (a rep)    -> only their own, matched by QB sales rep
 *     identity (qb_sales_order.sales_rep_list_id = the caller's linked
 *     qb_sales_rep.list_id) — NOT qb_sales_order.rep_id. rep_id is a
 *     TBWC-owned column an admin has to set by hand per order and is mostly
 *     unpopulated (see tbwc-orders-spreadsheet-mapping memory: rep-initial ->
 *     user resolution was never implemented); sales_rep_list_id instead comes
 *     straight off every order's QB SalesRepRef, so it's already correct and
 *     complete without any manual step.
 * Writes are admin-only.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';
import { findAll, findById, update, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { orderSchema } from './orderSchema';
import { queueFieldPush } from '../qbwc/pushQueue';

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
const SEARCH = ['customer_name', 'ref_number', 'invoice_number', 'po_number', 'build_notes'];
// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — 'invoice_status' is a fixed-options select, exact-match).
const LIKE_FIELDS = likeFieldsFromSchema(orderSchema);

// Fields whose edits don't write qb_sales_order directly — they're QB-owned,
// so a PUT queues them in qbwc_push_queue (generic outbox, see pushQueue.ts)
// instead, and salesOrder.ts's buildRequest sends them to QB as the next
// QBWC session runs. Maps the schema/API field name -> the object_type its
// qbwc_map/queue rows use. Add an entry here (and in salesOrder.ts's
// FIELD_TO_QB_TAG) for each new pushable field — no migration needed.
const PUSHABLE: Record<string, string> = {
  memo: 'SalesOrder',
};

// One correlated-subquery column per pushable field, COALESCEd over the real
// column so GET always returns one value under the field's normal name — the
// queued edit while it's in flight, the real synced value once it lands (or
// if nothing's queued). Same field the form edits; no separate "pending" one.
const PENDING_FIELD_SELECT = Object.entries(PUSHABLE)
  .map(([field, objectType]) =>
    `COALESCE((SELECT q.new_value FROM public.qbwc_push_queue q WHERE q.object_type = '${objectType}' ` +
    `AND q.txn_id = "${TABLE}".txn_id AND q.field_name = '${field}' AND q.status IN ('pending', 'failed')), ` +
    `"${TABLE}".${field}) AS ${field}`
  )
  .join(', ');

// sales_rep is synced straight off SalesRepRef.FullName, which QB actually
// populates with the rep's short Initial code (e.g. "POL"), not their name.
// Join qb_sales_rep by list_id to surface the real name instead; a correlated
// subquery (rather than crud.ts's `joins` option) keeps this working for both
// findAll and findById, and falls back to the raw synced value for any order
// whose rep isn't in qb_sales_rep (deleted rep, or not yet synced).
const SELECT_WITH_REP_NAME =
  `"${TABLE}".*, COALESCE(` +
  `(SELECT qsr.name FROM public.qb_sales_rep qsr WHERE qsr.list_id = "${TABLE}".sales_rep_list_id), ` +
  `"${TABLE}".sales_rep) AS sales_rep, ${PENDING_FIELD_SELECT}`;

// The only columns a PUT may touch — everything else on qb_sales_order is
// QB-owned (overwritten by sync) or maintained by refreshOrderInvoiceStatus().
// commission_total is a Postgres GENERATED column (commission + overage) —
// deliberately excluded here; the DB itself rejects a direct write to it.
const WRITABLE = new Set([
  'build_notes',
  'notes',
  'job_name',
  'expedite',
  'jay',
  'ship_no_later_than',
  'sold_for',
  'd_net_cost',
  'overage',
  'commission',
  'project_admin_fee',
  'trade_ally_fee',
  // No rep_id: order ownership comes from the QB sync (sales_rep_list_id),
  // not a manually-assigned column. rep_id is legacy/unused (already readOnly
  // in orderSchema) — excluded here so a PUT can never write it.
]);

function canSeeAll(user: any): boolean {
  return !!user?.is_admin;
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
  // Field filters first, then the security scope — sales_rep_list_id always
  // wins so a rep can't widen their own visibility via a crafted query param.
  // A rep with no linked qb_sales_rep (sales_rep_list_id null) gets a value
  // that can never match a real list_id, rather than falling through to an
  // `IS NULL` scope that would hand them every order QB hasn't assigned a rep to.
  const where: Record<string, any> = {
    ...fieldWhere,
    ...(canSeeAll(user) ? {} : { sales_rep_list_id: user.sales_rep_list_id ?? '__unlinked__' }),
    // Deleted in QB (see qbwc/objects/salesOrderDeleted.ts) — row is kept for its
    // TBWC-owned columns/history but must never appear as a live order.
    qb_deleted_at: null,
  };
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
  if (!row || row.qb_deleted_at) return c.json({ success: false, message: 'Order not found' }, 404);
  // Explicit null check, not `!==` — a rep with no linked qb_sales_rep and an
  // order with no assigned rep are both null, and `null !== null` is false,
  // which would otherwise let an unlinked rep see every unassigned order.
  if (!canSeeAll(user) && (!user.sales_rep_list_id || row.sales_rep_list_id !== user.sales_rep_list_id)) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  return c.json({ success: true, data: row });
});

app.put('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const data: Record<string, any> = {};
  const pushes: [string, any][] = [];
  for (const [k, v] of Object.entries(body)) {
    if (WRITABLE.has(k)) data[k] = v;
    else if (k in PUSHABLE) pushes.push([k, v]);
  }
  if (Object.keys(data).length === 0 && pushes.length === 0) {
    return c.json({ success: false, message: 'No editable fields in request' }, 400);
  }

  let txnId: string | undefined;
  if (Object.keys(data).length > 0) {
    // qb_sales_order has no updated_at column.
    const updated = await update(c.env, TABLE, PK, id, data, { touchUpdatedAt: false });
    if (!updated) return c.json({ success: false, message: 'Order not found or nothing to update' }, 404);
    txnId = updated.txn_id;
  }
  if (pushes.length > 0) {
    if (!txnId) {
      const existing = await findById(c.env, TABLE, PK, id);
      if (!existing) return c.json({ success: false, message: 'Order not found' }, 404);
      txnId = existing.txn_id;
    }
    const resolvedTxnId: string = txnId!;
    for (const [field, value] of pushes) {
      await queueFieldPush(c.env, PUSHABLE[field], resolvedTxnId, field, value == null ? null : String(value));
    }
  }

  const row = await findById(c.env, TABLE, PK, id, undefined, SELECT_WITH_REP_NAME);
  return c.json({ success: true, data: row });
});

// Orders exist only via the QuickBooks sync — no manual create/delete.
app.post('/', requireAdmin, (c) =>
  c.json({ success: false, message: 'Orders are created by the QuickBooks sync and cannot be created here.' }, 405));
app.delete('/:id', requireAdmin, (c) =>
  c.json({ success: false, message: 'Orders are managed by the QuickBooks sync and cannot be deleted here.' }, 405));

export default app;
