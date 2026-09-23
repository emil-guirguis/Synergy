/**
 * Invoices (QuickBooks) — read-only. Table public.qb_invoice, PK qb_invoice_id.
 * Populated by the QBWC pull (InvoiceQueryRq); the source of truth is QuickBooks,
 * so this module exposes list + detail only — nobody writes here.
 *
 * Admins see every invoice; a rep sees only their own. Ownership is
 * qb_invoice.sales_rep_list_id (migration 033), taken straight off QB's
 * SalesRepRef on InvoiceRet by the sync — no join to the sales order, because
 * InvoiceQueryRq is not sent with IncludeLinkedTxns and linked_txn is '[]'
 * on every row. ~350 of 7.8k invoices carry no rep: invisible to reps,
 * visible to admins.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { invoicesSchema } from './invoicesSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'qb_invoice';
const PK = 'qb_invoice_id';
const SEARCH = ['ref_number', 'customer_name'];
const LIKE_FIELDS = likeFieldsFromSchema(invoicesSchema);

// qb_invoice has no rep name of its own, only sales_rep_list_id (the QB
// SalesRepRef ListID) — join public.qb_sales_rep to surface it as `sales_rep`
// for the schema's read-only display field (see invoicesSchema.ts).
const SALES_REP_JOIN = `LEFT JOIN public.qb_sales_rep ON qb_sales_rep.list_id = "${TABLE}".sales_rep_list_id`;
const SELECT_WITH_SALES_REP = `"${TABLE}".*, qb_sales_rep.name AS sales_rep`;

/**
 * The caller's row scope, or null when their invoice:read grant covers every
 * row. An own-scoped caller with no linked qb_sales_rep gets a value that can
 * never match a real list_id rather than an IS NULL scope, which would hand
 * them every invoice with no linked order yet (mirrors orders.ts).
 *
 * No field redaction here on purpose: reps see every column on the invoices
 * that are theirs — totals, balance and paid status included.
 */
function repScope(c: any): string | null {
  return c.get('permissions').scopeOf('invoice:read') === 'own'
    ? (c.get('user').sales_rep_list_id ?? '__unlinked__')
    : null;
}

app.get('/', requirePermission('invoice:read'), async (c) => {
  const q = c.req.query();
  // txn_date_from/txn_date_to aren't real columns — they drive the whereRange
  // bound below (the Invoice Totals report's card drill-down links here with
  // them), so keep whereFromQuery from treating them as an exact-match field.
  const { where: fieldWhere, whereLike } = whereFromQuery(q, {
    likeFields: LIKE_FIELDS,
    extraReserved: ['txn_date_from', 'txn_date_to'],
  });
  // Field filters first, then the scope — it always wins, so a rep can't widen
  // their own visibility with a crafted sales_rep_list_id query param.
  const scope = repScope(c);
  const where: Record<string, any> = {
    ...fieldWhere,
    ...(scope === null ? {} : { sales_rep_list_id: scope }),
    // Deleted in QB (see qbwc/objects/txnDeleted.ts) — kept for the order module's
    // history, never shown as a live invoice.
    qb_deleted_at: null,
  };
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    orderBy: q.sortBy ? undefined : `"${TABLE}".txn_date DESC`,
    where,
    whereLike,
    whereRange: (q.txn_date_from || q.txn_date_to)
      ? { txn_date: { gte: q.txn_date_from || undefined, lte: q.txn_date_to || undefined } }
      : undefined,
    // $0 QB invoices are packing slips, not real invoices — never list them.
    whereNot: { total: 0 },
    joins: SALES_REP_JOIN,
    selectFields: SELECT_WITH_SALES_REP,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

// Dashboard's "Total Receivables" card, with a year picker like
// YearlyOrderTotalCard's. A dedicated SUM rather than the client-side
// bulk-fetch-and-reduce pattern the other dashboard cards use — this is a
// real financial total, not a rough KPI, and ~7.8k invoices company-wide is
// enough that a truncated client page could silently under-count it.
// ?year=YYYY selects the year (default: current); `years` in the response is
// every year actually present in qb_invoice.txn_date, for the dropdown's
// options — computed here rather than client-side because this route never
// fetches the underlying rows.
app.get('/receivables-summary', requirePermission('invoice:read'), async (c) => {
  const scope = repScope(c);
  const yearParam = parseInt(c.req.query('year') ?? '', 10);
  const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();

  const { rows } = await execQuery(
    c.env,
    `SELECT COALESCE(SUM(balance_remaining), 0)::numeric AS total, COUNT(*)::int AS count
       FROM public.qb_invoice
      WHERE qb_deleted_at IS NULL
        AND COALESCE(balance_remaining, 0) > 0
        AND extract(year FROM txn_date)::int = $2
        AND ($1::text IS NULL OR sales_rep_list_id = $1)`,
    [scope, year],
    'invoices.receivablesSummary'
  );
  const { rows: yearRows } = await execQuery(
    c.env,
    `SELECT DISTINCT extract(year FROM txn_date)::int AS y
       FROM public.qb_invoice
      WHERE qb_deleted_at IS NULL AND txn_date IS NOT NULL
        AND ($1::text IS NULL OR sales_rep_list_id = $1)
      ORDER BY y DESC`,
    [scope],
    'invoices.receivablesSummary.years'
  );
  return c.json({
    success: true,
    data: {
      total: Number(rows[0]?.total ?? 0),
      count: rows[0]?.count ?? 0,
      year,
      years: yearRows.map((r: any) => r.y),
    },
  });
});

app.get('/:id', requirePermission('invoice:read'), async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'), undefined, SELECT_WITH_SALES_REP, SALES_REP_JOIN);
  if (!row || row.qb_deleted_at) return c.json({ success: false, message: 'Invoice not found' }, 404);
  // 404 rather than 403 — a rep shouldn't be able to probe which invoice ids
  // exist. Compared against the scope value, so an unlinked rep matches nothing.
  const scope = repScope(c);
  if (scope !== null && row.sales_rep_list_id !== scope) {
    return c.json({ success: false, message: 'Invoice not found' }, 404);
  }
  return c.json({ success: true, data: row });
});

export default app;
