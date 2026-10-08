/**
 * Orders — backed by public.qb_sales_order (PK qb_sales_order_id), the QB-synced
 * staging table. Three kinds of row share it, told apart by order_type:
 *   - 'order' (default) — created/removed by the QuickBooks sync only. PUT
 *     updates just the TBWC-owned columns (the QB-owned ones would be
 *     clobbered by the next sync anyway); nothing here can create or delete one.
 *   - 'hold_for_release' / 'consignment' — TBWC-only placeholders (PLACEHOLDER_TYPES)
 *     for a sale not yet entered in QuickBooks (POST / below, chosen by the
 *     list's New menu). Every header field is editable directly (HOLD_WRITABLE)
 *     since there's no QB sync to clobber it, and nothing about either is ever
 *     pushed to QuickBooks — an admin deletes the row by hand (DELETE below)
 *     once the real order is entered in QB and synced in under its own
 *     txn_id. order_type is set once at creation and immutable after; no
 *     route ever writes it again.
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
import { AuthVariables, authenticateToken, requirePermission, visibleRepListIds } from '../middleware';
import { redactRow, redactRows, stripNonEditable } from '@meterit/framework-backend/api/base/permissions';
import { buildDocumentPdf, type DocumentHeader } from '../pdf/documentPdf';
import { dateStr, toDocumentLines, sendDocumentEmail } from '../pdf/documentEmail';
import { findAll, findById, create, update, whereFromQuery, likeFieldsFromSchema } from '../crud';
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

const HOLD_FOR_RELEASE = 'hold_for_release';
const CONSIGNMENT = 'consignment';
// Both are TBWC-only placeholders created from the list's New menu (migration
// 085 added CONSIGNMENT alongside the original HOLD_FOR_RELEASE) — same
// editable-field set, same never-synced-to-QB treatment, told apart only by
// which chip/label they carry downstream.
const PLACEHOLDER_TYPES = new Set([HOLD_FOR_RELEASE, CONSIGNMENT]);
const PLACEHOLDER_TYPES_SQL = `('${HOLD_FOR_RELEASE}', '${CONSIGNMENT}')`;

// Columns a placeholder order's header may set directly — QB-owned on every
// normal synced order (the next sync would clobber a direct edit), but a
// placeholder row has no QB source to be clobbered by, so an admin fills them
// in by hand instead. Never includes order_type itself: that's set
// once at creation (POST / below) and no route ever writes it again.
// No customer_name here — it's derived from the validated customer_list_id
// (see resolveCustomer below), never trusted as raw client text. No total
// either — like lines, it's computed from the line items (sumLines below),
// never independently settable. lines itself isn't here either: a jsonb
// column needs its own cast (see the raw queries in PUT/POST below), which
// the generic data[k]=v loop and crud.ts's create()/update() can't express.
const HOLD_WRITABLE = new Set([
  'ref_number', 'po_number', 'txn_date', 'due_date',
  'sales_rep_list_id', 'bill_address_block', 'ship_address_block',
  'freight_terms', 'ship_via', 'contact', 'customer_tax_code',
]);

/** Sum of each line's amount, rounded to cents — null for no lines, same as
 *  QB leaves `total` on a sales order with none. Mirrors quotes.ts's sumLines. */
function sumLines(lines: any): number | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const sum = lines.reduce((s: number, l: any) => s + (Number(l?.amount) || 0), 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Confirms `listId` is a real, non-deleted QuickBooks customer and returns its
 * authoritative name — server-side backstop for a hold-for-release order's
 * customer picker (OrderForm's ReferenceSearchField only ever commits a value
 * picked from a live /customers search, but nothing stops a stale or
 * hand-crafted request from naming a customer that doesn't exist, or one QB
 * has since deleted). Same pattern as quotes.ts's resolveCustomer.
 */
async function resolveCustomer(env: Env, listId: string): Promise<{ full_name: string | null } | null> {
  const r = await execQuery(
    env,
    `SELECT full_name FROM public.qb_customer WHERE list_id = $1 AND qb_deleted_at IS NULL`,
    [listId],
    'orders.resolveCustomer'
  );
  return r.rows[0] ?? null;
}

/**
 * Serial numbers, read live off the latest linked real invoice's own line
 * items — this company's QB file has no serial/lot tracking, so staff type
 * them straight into a line's Desc by hand (confirmed against live data, e.g.
 * "METER SERIAL # P032608004", "Serial #: P122607064" — mixed in with the
 * rest of that line's product description, not on a line of their own).
 * Every non-empty line Desc is joined verbatim, same as shipping_tracking
 * below — not regex-parsed out, since the surrounding text isn't consistent
 * enough to isolate just the serial reliably. Nothing is stored on the order
 * or the invoice for this (migration 082 dropped the Memo column migration
 * 080 added — wrong field entirely, serials were never there). Same
 * linked-invoice match as GET /:id/invoices (LinkedTxn, falling back to
 * customer + PO), excluding packing slips and deleted rows.
 */
async function latestInvoiceSerialNumbers(env: Env, order: { txn_id: string; po_number: string | null; customer_list_id: string | null }): Promise<string | null> {
  const po = (order.po_number ?? '').trim() || null;
  const r = await execQuery(
    env,
    `SELECT (
       SELECT string_agg(line->>'desc', '; ' ORDER BY ord)
         FROM jsonb_array_elements(i.lines) WITH ORDINALITY AS t(line, ord)
        WHERE line->>'desc' IS NOT NULL AND line->>'desc' <> ''
     ) AS serial_numbers
       FROM public.qb_invoice i
      WHERE i.qb_deleted_at IS NULL
        AND NOT i.is_packing_slip
        AND (i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', $1::text))
             OR ($2::text IS NOT NULL
                 AND i.customer_list_id = $3::text
                 AND nullif(btrim(i.po_number), '') = $2::text))
      ORDER BY i.txn_date DESC NULLS LAST, i.qb_invoice_id DESC
      LIMIT 1`,
    [order.txn_id, po, order.customer_list_id],
    'orders.latestInvoiceSerialNumbers'
  );
  return r.rows[0]?.serial_numbers ?? null;
}

// Mirrors OrderList.tsx's getOrderStatusChips() exactly — the frontend's
// "Not Invoiced"/"Not Shipped" status chips aren't real columns, so the
// list's chip filter needs the same predicate reproduced server-side (chips
// are computed per-row client-side, but filtering by them has to happen
// before pagination). Keep both in sync if the chip rules change.
const CHIP_CONDITIONS: Record<string, string> = {
  // Only applies once actually shipped — unbilled AND unshipped is
  // openSalesOrder below, not this one.
  notInvoiced: `"${TABLE}".invoice_status = 'Not Invoiced' AND "${TABLE}".actual_ship_date IS NOT NULL`,
  closed: `"${TABLE}".invoice_status = 'Closed'`,
  notShipped: `"${TABLE}".actual_ship_date IS NULL AND "${TABLE}".ship_no_later_than IS NOT NULL AND "${TABLE}".ship_no_later_than < CURRENT_DATE`,
  missingFinancials: `("${TABLE}".sold_for IS NULL OR "${TABLE}".commission IS NULL OR "${TABLE}".d_net_cost IS NULL)`,
  holdForRelease: `"${TABLE}".order_type = 'hold_for_release'`,
  consignment: `"${TABLE}".order_type = 'consignment'`,
  // No chip/filter-dropdown option for this one — it's only a dashboard-card
  // link target (OrderAlertsCards.tsx's "YTD Open Sales Orders" ->
  // /orders?chips=openSalesOrder). invoice_status='Not Invoiced' already means
  // not closed/paid/partially invoiced (see orderInvoiceStatus.ts's
  // precedence), so this is just that plus nothing manually shipped yet.
  openSalesOrder: `"${TABLE}".invoice_status = 'Not Invoiced' AND "${TABLE}".actual_ship_date IS NULL`,
};

/** True when this caller's order:read grant is limited to their own rows. */
function ownOnly(c: any): boolean {
  return c.get('permissions')?.scopeOf('order:read') === 'own';
}

// visibleRepListIds (own rep + every managed user's rep) now lives in
// middleware.ts — shared with quotes.ts/invoices.ts so "own scope" means
// the same thing everywhere.

app.get('/', requirePermission('order:read'), async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  // missingPo/notShipped/excludePackingSlip are synthetic filters (dashboard
  // alert cards), not real columns — keep them out of whereFromQuery's generic
  // pass and apply as raw checks below instead. "Not invoiced" needs no such
  // special-casing — is_fully_invoiced is a real column with its own
  // schema-generated filter, so ?is_fully_invoiced=false already flows through
  // whereFromQuery normally.
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS, extraReserved: ['missingPo', 'notShipped', 'excludePackingSlip', 'chips'] });
  // Field filters first, then the security scope below — sales_rep_list_id
  // always wins so a rep can't widen their own visibility via a crafted query
  // param. The scope itself is an IN-list (own rep + every managed user's rep),
  // not a single exact match, so it goes through whereRaw rather than `where`.
  const where: Record<string, any> = {
    ...fieldWhere,
    // Deleted in QB (see qbwc/objects/salesOrderDeleted.ts) — row is kept for its
    // TBWC-owned columns/history but must never appear as a live order.
    qb_deleted_at: null,
  };
  if (q.missingPo === 'true') where.po_number = null;
  if (q.notShipped === 'true') where.shipped_date = null;
  // A packing slip is a zero-total QB invoice linked to the order — a real
  // $0 invoice is NOT a packing slip, so total>0 is the wrong test for this;
  // has_packing_slip is the actual flag (migration 048, kept in sync by
  // orderInvoiceStatus.ts off the linked invoice's own template).
  if (q.excludePackingSlip === 'true') where.has_packing_slip = false;
  // chips=notInvoiced,notShipped — show only rows carrying ANY selected chip
  // (OR'd together in one clause); no chips selected means no filter (all rows).
  const selectedChips = (q.chips || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => CHIP_CONDITIONS[t]);
  const whereRaw: { sql: string; params?: any[] }[] = [];
  if (selectedChips.length > 0) {
    whereRaw.push({ sql: `(${selectedChips.map((t) => `(${CHIP_CONDITIONS[t]})`).join(' OR ')})` });
  }
  if (ownOnly(c)) {
    const repIds = visibleRepListIds(user);
    whereRaw.push(
      repIds.length > 0
        ? { sql: `sales_rep_list_id IN (${repIds.map(() => '?').join(', ')})`, params: repIds }
        : { sql: '1 = 0' }
    );
  }
  // Orders on/before 2022-06-30 are always excluded from the list — but a
  // placeholder row has no required txn_date (it's filled in by hand, see
  // HOLD_WRITABLE), and whereRange's >= comparison would otherwise hide a
  // brand-new one with no date set yet, or one dated before the cutoff, as if
  // it didn't exist. Exempt placeholder rows from the cutoff instead of
  // defaulting a date the admin never chose.
  whereRaw.push({ sql: `(order_type IN ${PLACEHOLDER_TYPES_SQL} OR txn_date >= '2022-07-01')` });
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
    whereRaw,
    selectFields: SELECT_WITH_REP_NAME,
  });
  // Field-level scope, not just row-level: the rep grant hides every dollar
  // figure on an order, including the ones nested in `lines` and the whole
  // `raw` QB blob. Applied here rather than by narrowing selectFields so the
  // rule stays data, editable per role.
  const items = redactRows(c.get('permissions'), 'order:read', result.rows);
  return c.json({ success: true, data: { items, total: result.pagination.total } });
});

// Full match-key + TBWC-owned-field snapshot of every non-deleted order, in one
// query — used by Settings > Commission Import (see CommissionImportPanel.tsx)
// to resolve each spreadsheet row's TBWC#/PO# to an order and diff the sheet's
// values against what's already stored, without one request per row (the
// build-list workbook runs into the thousands of rows). No txn_date cutoff
// (unlike GET /) since an older order should still be resolvable for backfill.
// Registered ABOVE GET /:id deliberately — both are single path segments, and
// Hono matches these in registration order, so this being below /:id meant
// "import-index" itself was captured as :id (bigint cast error, 500).
app.get('/import-index', requirePermission('order:write'), async (c) => {
  const user = c.get('user');
  const { rows } = await execQuery(
    c.env,
    `SELECT qb_sales_order_id, ref_number, po_number, customer_name, sales_rep_list_id,
            build_notes, job_name, expedite, jay, ship_no_later_than, actual_ship_date,
            sold_for, d_net_cost, overage, commission, project_admin_fee, trade_ally_fee,
            commission_total, notes
       FROM public.${TABLE}
      WHERE qb_deleted_at IS NULL`,
    [],
    'orders.importIndex'
  );
  const importRepIds = visibleRepListIds(user);
  const visible = ownOnly(c)
    ? rows.filter((r: any) => r.sales_rep_list_id && importRepIds.includes(r.sales_rep_list_id))
    : rows;
  return c.json({ success: true, data: redactRows(c.get('permissions'), 'order:read', visible) });
});

// Revenue Backlog & Pipeline: value of open (Not Invoiced / Partially
// Invoiced) orders minus what's already invoiced against them — a snapshot
// of what's still owed to the business, not a per-year sum (unlike
// YearlyOrderTotalCard/ReceivablesCard). "Invoiced" here is the SUM of every
// non-packing-slip invoice QB has LinkedTxn'd to the order (an order can be
// invoiced in more than one pass) — deliberately not the PO-number fallback
// /:id/invoices uses, since that's an inferred match meant for one order's
// own detail panel, not something to trust in a company-wide total.
// Registered above /:id (both are single path segments; see import-index's
// comment on registration order for why that matters with Hono).
app.get('/reports/backlog', requirePermission('order:read'), async (c) => {
  const user = c.get('user');
  const params: any[] = [];
  let repFilter = '';
  if (ownOnly(c)) {
    const repIds = visibleRepListIds(user);
    if (repIds.length === 0) return c.json({ success: true, data: { backlogTotal: 0, orderCount: 0 } });
    params.push(repIds);
    repFilter = `AND so.sales_rep_list_id = ANY($${params.length}::text[])`;
  }
  const { rows } = await execQuery(
    c.env,
    `SELECT
       COALESCE(SUM(
         CASE
           WHEN so.invoice_status = 'Not Invoiced' THEN so.total
           WHEN so.invoice_status = 'Partially Invoiced' THEN GREATEST(so.total - COALESCE(inv.invoiced, 0), 0)
           ELSE 0
         END
       ), 0) AS backlog_total,
       COUNT(*) FILTER (WHERE so.invoice_status IN ('Not Invoiced', 'Partially Invoiced')) AS order_count
     FROM public.${TABLE} so
     LEFT JOIN LATERAL (
       SELECT SUM(i.total) AS invoiced
         FROM public.qb_invoice i
        WHERE i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', so.txn_id))
          AND i.qb_deleted_at IS NULL
          AND NOT i.is_packing_slip
     ) inv ON true
     WHERE so.qb_deleted_at IS NULL
       AND (so.order_type IN ${PLACEHOLDER_TYPES_SQL} OR so.txn_date >= '2022-07-01')
       ${repFilter}`,
    params,
    'orders.backlogReport'
  );
  const row = rows[0] ?? {};
  return c.json({
    success: true,
    data: { backlogTotal: Number(row.backlog_total ?? 0), orderCount: Number(row.order_count ?? 0) },
  });
});

app.get('/:id', requirePermission('order:read'), async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'), undefined, SELECT_WITH_REP_NAME);
  if (!row || row.qb_deleted_at) return c.json({ success: false, message: 'Order not found' }, 404);
  // Explicit null check, not just includes() — a rep with no linked qb_sales_rep
  // and an order with no assigned rep are both null, and an empty repIds list
  // would otherwise let row.sales_rep_list_id (null) slip through if it were
  // ever checked with `includes` alone against a list containing null.
  if (ownOnly(c) && (!row.sales_rep_list_id || !visibleRepListIds(user).includes(row.sales_rep_list_id))) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  row.serial_numbers = await latestInvoiceSerialNumbers(c.env, row);
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
  const lookupRepIds = visibleRepListIds(user);
  const visible = ownOnly(c)
    ? rows.filter((r: any) => r.sales_rep_list_id && lookupRepIds.includes(r.sales_rep_list_id))
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
            i.balance_remaining, i.is_paid, i.is_packing_slip,
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
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Order not found' }, 404);
  // No role grants own-scoped order:write today, but the scope is editable per
  // role, so honour it here rather than assuming write implies every row.
  if (c.get('permissions').scopeOf('order:write') === 'own') {
    const user = c.get('user');
    if (!user.sales_rep_list_id || existing.sales_rep_list_id !== user.sales_rep_list_id) {
      return c.json({ success: false, message: 'Not found' }, 404);
    }
  }
  const isPlaceholder = PLACEHOLDER_TYPES.has(existing.order_type);
  // Field-level security (role_permission.field_access, edit:false) on top of
  // the WRITABLE/HOLD_WRITABLE allowlists below — those say what a PUT can
  // ever touch at all; this says what THIS caller's role may touch within it.
  const body = stripNonEditable(c.get('permissions'), 'order:write', await c.req.json());
  const data: Record<string, any> = {};
  const pushes: [string, any][] = [];
  // Validated here rather than falling into the generic loop below — the
  // customer is never trusted as raw text (see HOLD_WRITABLE's comment), so
  // setting it always resolves customer_list_id against QuickBooks' own
  // customer list and derives customer_name from that, not from the request.
  if (isPlaceholder && 'customer_list_id' in body) {
    const customer = await resolveCustomer(c.env, body.customer_list_id);
    if (!customer) {
      return c.json({ success: false, message: 'Unknown customer — pick one from the search results' }, 400);
    }
    data.customer_list_id = body.customer_list_id;
    data.customer_name = customer.full_name;
  }
  for (const [k, v] of Object.entries(body)) {
    if (k === 'customer_list_id' || k === 'lines') continue; // handled separately (lines needs its own ::jsonb cast)
    if (WRITABLE.has(k) || (isPlaceholder && HOLD_WRITABLE.has(k))) { data[k] = v; continue; }
    if (k in PUSHABLE) {
      // A placeholder row never reaches QuickBooks — write pushable fields
      // (memo) directly to the column instead of staging them in
      // qbwc_push_queue, which is keyed by txn_id and would just sit there
      // forever against this row's synthetic one.
      if (isPlaceholder) data[k] = v;
      else pushes.push([k, v]);
    }
  }
  // lines is jsonb — crud.ts's generic update() has no per-column cast, so
  // it's written with its own explicit ::jsonb statement instead (same
  // reason quotes.ts hand-rolls its own SQL for this column). total is
  // recomputed from it in the same statement, same as quotes.ts's sumLines.
  const linesUpdate = isPlaceholder && 'lines' in body;
  const lines = linesUpdate ? (Array.isArray(body.lines) ? body.lines : []) : null;

  if (Object.keys(data).length === 0 && pushes.length === 0 && !linesUpdate) {
    return c.json({ success: false, message: 'No editable fields in request' }, 400);
  }

  if (Object.keys(data).length > 0) {
    // qb_sales_order has no updated_at column.
    const updated = await update(c.env, TABLE, PK, id, data, { touchUpdatedAt: false });
    if (!updated) return c.json({ success: false, message: 'Order not found or nothing to update' }, 404);
  }
  if (linesUpdate) {
    await execQuery(
      c.env,
      `UPDATE public.${TABLE} SET lines = $1::jsonb, total = $2 WHERE ${PK} = $3`,
      [JSON.stringify(lines), sumLines(lines), id],
      'orders.updateLinesHold'
    );
  }
  for (const [field, value] of pushes) {
    await queueFieldPush(c.env, PUSHABLE[field], existing.txn_id, field, value == null ? null : String(value));
  }

  const row = await findById(c.env, TABLE, PK, id, undefined, SELECT_WITH_REP_NAME);
  return c.json({ success: true, data: row });
});

// Creates a placeholder order (Hold for Release or Consignment, chosen by the
// list's New menu) — a TBWC-only row that never syncs from, or pushes to,
// QuickBooks (see HOLD_WRITABLE above and the module header comment). A real
// order still only ever arrives via the QB sync; an admin deletes this
// placeholder by hand once the real one lands (DELETE below only allows that
// for a placeholder row).
app.post('/', requirePermission('order:write'), async (c) => {
  const body = stripNonEditable(c.get('permissions'), 'order:write', await c.req.json().catch(() => ({})));
  if (!body.customer_list_id) {
    return c.json({ success: false, message: 'customer_list_id is required' }, 400);
  }
  // Defaults to hold_for_release for back-compat with any caller that omits
  // it; otherwise must be one of the two creatable placeholder types — 'order'
  // itself is never creatable here (QB sync owns those rows).
  const orderType = typeof body.order_type === 'string' ? body.order_type : HOLD_FOR_RELEASE;
  if (!PLACEHOLDER_TYPES.has(orderType)) {
    return c.json({ success: false, message: `Invalid order_type: ${orderType}` }, 400);
  }
  const customer = await resolveCustomer(c.env, body.customer_list_id);
  if (!customer) {
    return c.json({ success: false, message: 'Unknown customer — pick one from the search results' }, 400);
  }
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const data: Record<string, any> = {
    order_type: orderType,
    // Unique, non-null stand-in for QB's own TxnID (NOT NULL UNIQUE) — this
    // row has no real one and never will.
    txn_id: `HOLD-${crypto.randomUUID()}`,
    customer_list_id: body.customer_list_id,
    customer_name: customer.full_name,
    // Defaults to today — every order needs an Order Date and, unlike a
    // QB-synced row, there's no sync to ever backfill one.
    txn_date: body.txn_date ?? new Date().toISOString().slice(0, 10),
    // Computed from any lines given up front, same as a PUT's linesUpdate —
    // total is never independently settable (see HOLD_WRITABLE's comment).
    total: sumLines(lines),
  };
  for (const [k, v] of Object.entries(body)) {
    if (k === 'customer_list_id' || k === 'txn_date' || k === 'lines' || k === 'total') continue; // handled above
    if (HOLD_WRITABLE.has(k)) data[k] = v;
  }
  const row = await create(c.env, TABLE, data);
  if (lines.length > 0) {
    // lines is jsonb — create()'s generic INSERT has no per-column cast (see
    // the PUT handler's same note), so it's set in a follow-up statement
    // instead of the initial insert.
    await execQuery(
      c.env,
      `UPDATE public.${TABLE} SET lines = $1::jsonb WHERE ${PK} = $2`,
      [JSON.stringify(lines), row[PK]],
      'orders.createLinesHold'
    );
    row.lines = lines;
  }
  return c.json({ success: true, data: row }, 201);
});

// Email a PDF of the order — same underlying build+send as the AI chat
// email_order tool (see pdf/documentEmail.ts), exposed as a direct action on
// the order list/form instead of requiring the chat. order:write-gated to
// match the AI tool's own admin/employee-only restriction (REP_TOOL_NAMES in
// aiChat.ts excludes it) — reps can't send these.
async function loadOrderForEmail(env: Env, id: string) {
  const result = await execQuery(
    env,
    `SELECT o.ref_number, o.customer_name, o.job_name, o.po_number, o.txn_date, o.total,
            o.bill_address_block, o.lines, c.email AS customer_email,
            u.email AS rep_email, u.first_name AS rep_first_name, u.last_name AS rep_last_name
       FROM public.qb_sales_order o
       LEFT JOIN public.qb_customer c ON c.list_id = o.customer_list_id AND c.qb_deleted_at IS NULL
       LEFT JOIN public.qb_sales_rep sr ON sr.list_id = o.sales_rep_list_id
       LEFT JOIN public.users u ON u.qb_sales_rep_id = sr.qb_sales_rep_id
      WHERE o.qb_sales_order_id = $1 AND o.qb_deleted_at IS NULL`,
    [id],
    'orders.loadForEmail'
  );
  return result.rows[0] ?? null;
}

function orderEmailHeader(row: any): DocumentHeader {
  return {
    kind: 'Order',
    refNumber: row.ref_number,
    customerName: row.customer_name,
    billTo: row.bill_address_block,
    date: dateStr(row.txn_date),
    poNumber: row.po_number,
    jobName: row.job_name,
    total: row.total != null ? Number(row.total) : null,
  };
}

// Preview the default recipient/sender/subject before sending — the dialog
// pre-fills with these, all editable.
app.get('/:id/email', requirePermission('order:write'), async (c) => {
  const row = await loadOrderForEmail(c.env, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Order not found' }, 404);
  const repName = [row.rep_first_name, row.rep_last_name].filter(Boolean).join(' ') || null;
  return c.json({
    success: true,
    data: {
      customerEmail: row.customer_email ?? null,
      refNumber: row.ref_number,
      customerName: row.customer_name,
      jobName: row.job_name,
      repEmail: row.rep_email ?? null,
      repName,
    },
  });
});

// Same PDF the email will attach — the dialog embeds this so the sender can
// check it before sending, rather than finding out after it's already out.
app.get('/:id/email/pdf', requirePermission('order:write'), async (c) => {
  const row = await loadOrderForEmail(c.env, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Order not found' }, 404);
  const pdfBytes = await buildDocumentPdf(orderEmailHeader(row), toDocumentLines(row.lines));
  // pdf-lib's Uint8Array return type doesn't pin its buffer to plain
  // ArrayBuffer (vs. ArrayBufferLike/SharedArrayBuffer), which current DOM
  // lib typings want for BlobPart — it's never actually shared memory here.
  return new Response(new Blob([pdfBytes as BlobPart]), { headers: { 'Content-Type': 'application/pdf' } });
});

app.post('/:id/email', requirePermission('order:write'), async (c) => {
  const row = await loadOrderForEmail(c.env, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Order not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const recipientEmail = (typeof body.recipientEmail === 'string' ? body.recipientEmail.trim() : '') || row.customer_email;
  if (!recipientEmail) {
    return c.json({ success: false, message: 'No email on file for this customer — enter an address to send it to.' }, 400);
  }
  const message = typeof body.message === 'string' ? body.message : undefined;
  const subject = typeof body.subject === 'string' ? body.subject : undefined;
  // Reply-To, not the envelope From (SMTP_FROM is fixed) — defaults to
  // whoever is actually sending this (the logged-in caller), not the order's
  // assigned rep, since an admin/employee can send on a rep's behalf. See
  // documentEmail.ts's SendDocumentEmailOptions.
  const replyTo = (typeof body.replyTo === 'string' ? body.replyTo.trim() : '') || c.get('user')?.email || undefined;

  try {
    await sendDocumentEmail(c.env, orderEmailHeader(row), toDocumentLines(row.lines), recipientEmail, { message, subject, replyTo });
  } catch (e: any) {
    return c.json({ success: false, message: e?.message || 'Failed to send email' }, 502);
  }
  return c.json({ success: true, data: { sent: true, recipient: recipientEmail, refNumber: row.ref_number } });
});

// A placeholder (Hold for Release or Consignment) can be discarded outright;
// a real, QB-synced order is managed by QuickBooks and deletion happens there.
app.delete('/:id', requirePermission('order:delete'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Order not found' }, 404);
  if (!PLACEHOLDER_TYPES.has(existing.order_type)) {
    return c.json({ success: false, message: 'Orders are managed by the QuickBooks sync and cannot be deleted here.' }, 405);
  }
  const r = await execQuery(c.env, `DELETE FROM public.${TABLE} WHERE ${PK} = $1 RETURNING *`, [id], 'orders.deleteHold');
  return c.json({ success: true, data: r.rows[0] });
});

export default app;
