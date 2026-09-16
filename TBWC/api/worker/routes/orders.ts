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
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { redactRow, redactRows } from '@meterit/framework-backend/api/base/permissions';
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
  'service',
  'ship_no_later_than',
  'actual_ship_date',
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

/** True when this caller's order:read grant is limited to their own rows. */
function ownOnly(c: any): boolean {
  return c.get('permissions')?.scopeOf('order:read') === 'own';
}

app.get('/', requirePermission('order:read'), async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  // missingPo/notShipped/excludeZeroTotal are synthetic filters (dashboard alert
  // cards), not real columns — keep them out of whereFromQuery's generic pass
  // and apply as raw checks below instead. "Not invoiced" needs no such
  // special-casing — is_fully_invoiced is a real column with its own
  // schema-generated filter, so ?is_fully_invoiced=false already flows through
  // whereFromQuery normally.
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS, extraReserved: ['missingPo', 'notShipped', 'excludeZeroTotal'] });
  // Field filters first, then the security scope — sales_rep_list_id always
  // wins so a rep can't widen their own visibility via a crafted query param.
  // A rep with no linked qb_sales_rep (sales_rep_list_id null) gets a value
  // that can never match a real list_id, rather than falling through to an
  // `IS NULL` scope that would hand them every order QB hasn't assigned a rep to.
  const where: Record<string, any> = {
    ...fieldWhere,
    ...(ownOnly(c) ? { sales_rep_list_id: user.sales_rep_list_id ?? '__unlinked__' } : {}),
    // Deleted in QB (see qbwc/objects/salesOrderDeleted.ts) — row is kept for its
    // TBWC-owned columns/history but must never appear as a live order.
    qb_deleted_at: null,
  };
  if (q.missingPo === 'true') where.po_number = null;
  if (q.notShipped === 'true') where.shipped_date = null;
  // Zero-total rows are packing slips (QB records these as zero-total invoices —
  // see OrderInvoicesPanel.tsx), not real open orders, so exclude them here.
  if (q.excludeZeroTotal === 'true') where.total = { gt: 0 };
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
  // Field-level scope, not just row-level: the rep grant hides every dollar
  // figure on an order, including the ones nested in `lines` and the whole
  // `raw` QB blob. Applied here rather than by narrowing selectFields so the
  // rule stays data, editable per role.
  const items = redactRows(c.get('permissions'), 'order:read', result.rows);
  return c.json({ success: true, data: { items, total: result.pagination.total } });
});

app.get('/:id', requirePermission('order:read'), async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'), undefined, SELECT_WITH_REP_NAME);
  if (!row || row.qb_deleted_at) return c.json({ success: false, message: 'Order not found' }, 404);
  // Explicit null check, not `!==` — a rep with no linked qb_sales_rep and an
  // order with no assigned rep are both null, and `null !== null` is false,
  // which would otherwise let an unlinked rep see every unassigned order.
  if (ownOnly(c) && (!user.sales_rep_list_id || row.sales_rep_list_id !== user.sales_rep_list_id)) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  return c.json({ success: true, data: redactRow(c.get('permissions'), 'order:read', row) });
});

// Exact PO lookup for the Settings > Document Import routine (see
// DocumentImportPanel.tsx): a folder name has to resolve to exactly one order
// before its files get attached, so this is a trimmed/case-insensitive EXACT
// match — unlike /?po_number=, which goes through LIKE_FIELDS as a partial
// ILIKE and would happily "match" every PO that merely contains the string.
app.get('/lookup-po/:po', requirePermission('order:read'), async (c) => {
  const user = c.get('user');
  const po = c.req.param('po').trim();
  if (!po) return c.json({ success: false, message: 'po is required' }, 400);
  const { rows } = await execQuery(
    c.env,
    `SELECT qb_sales_order_id, ref_number, customer_name, po_number, sales_rep_list_id
       FROM public.${TABLE}
      WHERE qb_deleted_at IS NULL AND lower(btrim(po_number)) = lower($1)`,
    [po],
    'orders.lookupPo'
  );
  const visible = ownOnly(c)
    ? rows.filter((r: any) => user.sales_rep_list_id && r.sales_rep_list_id === user.sales_rep_list_id)
    : rows;
  return c.json({ success: true, data: redactRows(c.get('permissions'), 'order:read', visible) });
});

// Invoices linked to this order, for the order form's right-hand panel.
// Linkage is QB's LinkedTxn where present, falling back to (customer + PO) —
// see the comment on the query below for why the fallback has to exist.
// Both groups come from one query; the form splits them (total > 0 = invoice,
// total = 0 = packing slip) so there is one round trip, not two.
// Scope: reuses the order's own visibility check below — if the caller can see
// the order, they can see what it was invoiced on. Deliberately NOT scoped by
// qb_invoice.sales_rep_list_id the way /invoices is: ~350 invoices carry no rep
// (see invoices.ts) and hiding those from a rep's own order would make the
// panel silently incomplete.
app.get('/:id/invoices', requirePermission('order:read'), async (c) => {
  const user = c.get('user');
  const order = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!order || order.qb_deleted_at) return c.json({ success: false, message: 'Order not found' }, 404);
  if (ownOnly(c) && (!user.sales_rep_list_id || order.sales_rep_list_id !== user.sales_rep_list_id)) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  // Two ways an invoice belongs to this order:
  //   'link' — QB's own LinkedTxn (authoritative).
  //   'po'   — same customer + same PO number (inferred). Needed because QB
  //            only returns LinkedTxn when asked, and InvoiceQueryRq didn't ask
  //            until this change, so linked_txn is empty on every invoice
  //            synced before it and stays empty until that invoice is touched
  //            in QB again. 4449 of 4583 orders match this way (migration 037).
  // matched_by says which, and flags the only case actually worth a warning in
  // the UI: 'ambiguous' — a PO match where that same customer+PO appears on
  // more than one order, so this invoice may well belong to one of the others
  // (~270 invoices company-wide). A plain 'po' match is inferred but unshared,
  // and while linked_txn is empty everywhere that describes nearly every row —
  // badging all of them would be noise.
  const po = (order.po_number ?? '').trim() || null;
  const { rows } = await execQuery(
    c.env,
    `SELECT i.qb_invoice_id, i.ref_number, i.txn_date, i.due_date, i.total,
            i.balance_remaining, i.is_paid,
            CASE
              WHEN i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', $1::text))
                THEN 'link'
              WHEN (SELECT count(*) FROM public.qb_sales_order o2
                     WHERE o2.qb_deleted_at IS NULL
                       AND o2.customer_list_id = i.customer_list_id
                       AND nullif(btrim(o2.po_number), '') = nullif(btrim(i.po_number), '')) > 1
                THEN 'ambiguous'
              ELSE 'po'
            END AS matched_by
     FROM public.qb_invoice i
     WHERE i.qb_deleted_at IS NULL
       AND (i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', $1::text))
            OR ($2::text IS NOT NULL
                AND i.customer_list_id = $3::text
                AND nullif(btrim(i.po_number), '') = $2::text))
     ORDER BY i.txn_date DESC NULLS LAST, i.qb_invoice_id DESC`,
    [order.txn_id, po, order.customer_list_id],
    'orders.linkedInvoices'
  );
  return c.json({ success: true, data: { items: rows } });
});

// Payments (QB ReceivePayment) applied against this order's invoices, for the
// order form's summary panel — one row per (payment, invoice) pair, so the
// panel can list each payment under the specific invoice it was applied to
// rather than in a section of its own. Same invoice-match rule as
// /:id/invoices (QB LinkedTxn, falling back to customer + PO).
//
// amount is the slice of a split payment applied to THIS invoice specifically
// (qb_payment.applied_to can name invoices across several orders, or several
// invoices on the same order, for the same customer) — not the payment's
// total_amount.
//
// Requires payment.ts's ReceivePaymentQueryRq to have pulled with
// IncludeLineItems=true; older rows synced before that carry an empty
// applied_to and won't show here until a Payment full reload re-pulls them.
app.get('/:id/payments', requirePermission('order:read'), async (c) => {
  const user = c.get('user');
  const order = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!order || order.qb_deleted_at) return c.json({ success: false, message: 'Order not found' }, 404);
  if (ownOnly(c) && (!user.sales_rep_list_id || order.sales_rep_list_id !== user.sales_rep_list_id)) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  const po = (order.po_number ?? '').trim() || null;
  const { rows } = await execQuery(
    c.env,
    `WITH order_invoices AS (
       SELECT i.txn_id, i.qb_invoice_id
         FROM public.qb_invoice i
        WHERE i.qb_deleted_at IS NULL
          AND (i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', $1::text))
               OR ($2::text IS NOT NULL
                   AND i.customer_list_id = $3::text
                   AND nullif(btrim(i.po_number), '') = $2::text))
     )
     SELECT p.qb_payment_id, p.ref_number, p.txn_date, oi.qb_invoice_id,
            (a->>'amount')::numeric AS amount
       FROM public.qb_payment p
       CROSS JOIN LATERAL jsonb_array_elements(p.applied_to) a
       JOIN order_invoices oi ON oi.txn_id = a->>'txn_id'
      ORDER BY p.txn_date DESC NULLS LAST, p.qb_payment_id DESC`,
    [order.txn_id, po, order.customer_list_id],
    'orders.linkedPayments'
  );
  return c.json({ success: true, data: { items: rows } });
});

app.put('/:id', requirePermission('order:write'), async (c) => {
  const id = c.req.param('id');
  // No role grants own-scoped order:write today, but the scope is editable per
  // role, so honour it here rather than assuming write implies every row.
  if (c.get('permissions').scopeOf('order:write') === 'own') {
    const user = c.get('user');
    const existing = await findById(c.env, TABLE, PK, id);
    if (!existing || !user.sales_rep_list_id || existing.sales_rep_list_id !== user.sales_rep_list_id) {
      return c.json({ success: false, message: 'Not found' }, 404);
    }
  }
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
app.post('/', requirePermission('order:write'), (c) =>
  c.json({ success: false, message: 'Orders are created by the QuickBooks sync and cannot be created here.' }, 405));
app.delete('/:id', requirePermission('order:delete'), (c) =>
  c.json({ success: false, message: 'Orders are managed by the QuickBooks sync and cannot be deleted here.' }, 405));

export default app;
