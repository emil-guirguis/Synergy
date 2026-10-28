/**
 * AR Aging report: how much money is late, and by how long. Four disjoint
 * bands — 1–30, 31–60, 61–90 and over 90 days past due — each as a count of
 * invoices and the dollars outstanding on them, plus one figure for everything
 * 1+ day late as the headline.
 *
 * Disjoint and exhaustive: an invoice lands in exactly one band, and the four
 * cover every past-due invoice, so they add up to the headline exactly. A
 * cumulative reading ("everything past 60 days") would double-count the oldest
 * rows and make the numbers unsummable, which is why the bands are closed at
 * both ends except the tail.
 *
 * "Past due" is the same predicate the Invoices list computes `days_past_due`
 * from (see invoices.ts): an open balance (balance_remaining > 0 — not
 * `is_paid`, which QB leaves stale on partially-applied invoices) whose
 * due_date is behind us. The dollar figure is that open balance, not `total`,
 * since a partially-paid invoice is only late for what's still owed. Each
 * band comes back with its own bounds, which the frontend hands straight back
 * to GET /invoices below as minDays/maxDays — so clicking a band's tile shows
 * exactly the rows that produced its number.
 *
 * ?customerListId=<ListID> narrows every figure to one customer; `customers`
 * in the response is the dropdown's options — only customers who actually have
 * a past-due invoice in the caller's scope, so the filter can never select a
 * combination that reads as zero for lack of data rather than lack of debt.
 *
 * GET /invoices returns the rows behind those figures for the report's own
 * table — the same predicate, the same filters, plus the per-row collection
 * detail (notice dates, fee flag, AR notes) and the customer's derived ADP.
 * The report shows that table in place rather than sending a click off to the
 * Invoices list, so the aging numbers and the invoices they're made of stay on
 * one screen.
 *
 * Packing slips (qb_invoice.is_packing_slip — migration 066) and QB-side
 * deletions (qb_deleted_at) are excluded, by both the figures and the table,
 * so a tile's count always equals the number of rows it shows.
 *
 * arAging:read honours its scope through middleware's reportRepScope like
 * every other report — at `own` every band covers the caller's own rep plus
 * anyone they manage, so a rep reads their own late book, not the company's.
 *
 * Single aggregate endpoint, not a CRUD module — same shape as
 * invoiceTotals.ts and invoices.ts's receivables-summary.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission, reportRepScope } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('arAging:read'));

/**
 * The bands, by days past due. Inclusive at both ends; `maxDays: null` is the
 * open-ended tail. Contiguous, non-overlapping and starting at 1, so together
 * they account for every past-due invoice exactly once.
 */
export const AGING_BANDS = [
  { minDays: 1, maxDays: 30 },
  { minDays: 31, maxDays: 60 },
  { minDays: 61, maxDays: 90 },
  { minDays: 91, maxDays: null },
] as const;

app.get('/summary', async (c) => {
  // null at `all` scope; the caller's own + managed reps at `own`.
  const scope = reportRepScope(c, 'arAging:read');
  const customerListId = c.req.query('customerListId') || null;

  // One pass over the open invoices, bucketed with FILTER — four separate
  // scans would read the same rows four times for no gain, and a subquery
  // keeps the days-late expression written once.
  const [summary, customers] = await Promise.all([
    execQuery(
      c.env,
      `SELECT
         COUNT(*)::int AS count_all,
         COALESCE(SUM(balance_remaining), 0)::numeric AS total_all,
         COUNT(*) FILTER (WHERE days_late BETWEEN 1 AND 30)::int AS count_1,
         COALESCE(SUM(balance_remaining) FILTER (WHERE days_late BETWEEN 1 AND 30), 0)::numeric AS total_1,
         COUNT(*) FILTER (WHERE days_late BETWEEN 31 AND 60)::int AS count_31,
         COALESCE(SUM(balance_remaining) FILTER (WHERE days_late BETWEEN 31 AND 60), 0)::numeric AS total_31,
         COUNT(*) FILTER (WHERE days_late BETWEEN 61 AND 90)::int AS count_61,
         COALESCE(SUM(balance_remaining) FILTER (WHERE days_late BETWEEN 61 AND 90), 0)::numeric AS total_61,
         COUNT(*) FILTER (WHERE days_late >= 91)::int AS count_91,
         COALESCE(SUM(balance_remaining) FILTER (WHERE days_late >= 91), 0)::numeric AS total_91
       FROM (
         SELECT balance_remaining, (CURRENT_DATE - due_date)::int AS days_late
           FROM public.qb_invoice
          WHERE qb_deleted_at IS NULL
            AND NOT is_packing_slip
            AND due_date IS NOT NULL
            AND due_date < CURRENT_DATE
            AND COALESCE(balance_remaining, 0) > 0
            AND ($1::text[] IS NULL OR sales_rep_list_id = ANY($1::text[]))
            AND ($2::text IS NULL OR customer_list_id = $2)
       ) aged`,
      [scope, customerListId],
      'arAging.summary'
    ),
    // Dropdown options. Deliberately NOT every qb_customer row: a customer
    // with nothing past due would read as "$0 across the board" and look like
    // a bug. Scoped the same way the figures are, so an own-scoped caller is
    // never offered a customer whose numbers they can't see.
    execQuery(
      c.env,
      `SELECT DISTINCT customer_list_id AS list_id, customer_name AS name
         FROM public.qb_invoice
        WHERE qb_deleted_at IS NULL
          AND NOT is_packing_slip
          AND due_date IS NOT NULL
          AND due_date < CURRENT_DATE
          AND COALESCE(balance_remaining, 0) > 0
          AND customer_list_id IS NOT NULL
          AND ($1::text[] IS NULL OR sales_rep_list_id = ANY($1::text[]))
        ORDER BY name`,
      [scope],
      'arAging.customers'
    ),
  ]);

  const row = summary.rows[0] ?? {};
  return c.json({
    success: true,
    data: {
      customerListId,
      customers: customers.rows,
      // Everything 1+ day late — equal to the four bands combined, since they
      // start at 1 and leave no gap.
      pastDue: { minDays: 1, maxDays: null, count: row.count_all ?? 0, total: Number(row.total_all ?? 0) },
      buckets: AGING_BANDS.map(({ minDays, maxDays }) => ({
        minDays,
        maxDays,
        count: row[`count_${minDays}`] ?? 0,
        total: Number(row[`total_${minDays}`] ?? 0),
      })),
    },
  });
});

/**
 * Scope + filter predicate shared by the table below. Returns the SQL and the
 * parameters in the order the caller must bind them, so the table and the
 * figures above can never disagree about which invoices are "past due".
 */
function pastDueWhere(scope: string[] | null, customerListId: string | null, minDays: number | null, maxDays: number | null) {
  return {
    sql: `i.qb_deleted_at IS NULL
      AND NOT i.is_packing_slip
      AND i.due_date IS NOT NULL
      AND i.due_date < CURRENT_DATE
      AND COALESCE(i.balance_remaining, 0) > 0
      AND ($1::text[] IS NULL OR i.sales_rep_list_id = ANY($1::text[]))
      AND ($2::text IS NULL OR i.customer_list_id = $2)
      AND ($3::int IS NULL OR (CURRENT_DATE - i.due_date)::int >= $3)
      AND ($4::int IS NULL OR (CURRENT_DATE - i.due_date)::int <= $4)`,
    params: [scope, customerListId, minDays, maxDays],
  };
}

/** Guard against an unbounded payload; the whole past-due book is ~130 rows today. */
const ROW_LIMIT = 1000;

app.get('/invoices', async (c) => {
  const scope = reportRepScope(c, 'arAging:read');
  const customerListId = c.req.query('customerListId') || null;
  const min = parseInt(c.req.query('minDays') ?? '', 10);
  const max = parseInt(c.req.query('maxDays') ?? '', 10);
  const where = pastDueWhere(
    scope,
    customerListId,
    Number.isFinite(min) ? min : null,
    Number.isFinite(max) ? max : null
  );

  // ADP per customer in one pass and LEFT JOINed, rather than the detail
  // route's one-customer query run per row — see invoices.ts's avgDaysToPay
  // for why this is derived at all (QuickBooks never sends it).
  const { rows } = await execQuery(
    c.env,
    `WITH pay AS (
       SELECT (a->>'txn_id') AS inv_txn_id, p.txn_date AS paid_date
         FROM public.qb_payment p
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.applied_to, '[]'::jsonb)) a
        WHERE a->>'txn_type' = 'Invoice'
          AND p.txn_date IS NOT NULL
     ),
     paid AS (
       SELECT inv.customer_list_id, (MIN(pay.paid_date) - inv.txn_date)::int AS days
         FROM public.qb_invoice inv
         JOIN pay ON pay.inv_txn_id = inv.txn_id
        WHERE inv.qb_deleted_at IS NULL
          AND NOT inv.is_packing_slip
          AND inv.txn_date IS NOT NULL
        GROUP BY inv.qb_invoice_id, inv.customer_list_id, inv.txn_date
     ),
     adp AS (
       SELECT customer_list_id, round(avg(days))::int AS adp
         FROM paid WHERE days >= 0 GROUP BY customer_list_id
     )
     SELECT
       i.qb_invoice_id,
       -- The invoice form fetches by \`id\`; without it a row click opens nothing.
       i.qb_invoice_id AS id,
       i.customer_name,
       i.balance_remaining,
       i.ref_number,
       i.txn_date,
       i.due_date,
       i.notice_1_date, i.notice_2_date, i.notice_3_date,
       (CURRENT_DATE - i.txn_date)::int AS days_since_invoice,
       (CURRENT_DATE - i.due_date)::int AS days_past_due,
       adp.adp AS avg_days_to_pay,
       i.late_fee_applied,
       i.ar_notes
       FROM public.qb_invoice i
       LEFT JOIN adp ON adp.customer_list_id = i.customer_list_id
      WHERE ${where.sql}
      ORDER BY i.customer_name, i.ref_number
      LIMIT ${ROW_LIMIT}`,
    where.params,
    'arAging.invoices'
  );

  return c.json({ success: true, data: { items: rows, limit: ROW_LIMIT } });
});

export default app;
