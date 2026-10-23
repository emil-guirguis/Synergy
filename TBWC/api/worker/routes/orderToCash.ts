/**
 * Order-to-Cash Pipeline (Bottleneck Finder). Maps
 * Sales Order -> Invoice -> Payment status to surface where cash is stuck:
 * how much is booked but not yet billed, which specific orders are oldest in
 * that state, and how long paid invoices actually take to collect.
 *
 * ?year=YYYY filters all three figures to that year (order txn_date for the
 * open-orders figures, invoice txn_date for collection speed) and is the
 * default — the current year, like every other report's year picker. Pass
 * year=all for the all-time/current-snapshot view (what this defaulted to
 * before, which buried this year's bottlenecks under a decade of history).
 *
 * orderToCash:read honours its scope through middleware's reportRepScope,
 * like every other report: at `own` every figure (open value, the uninvoiced
 * list, collection speed, the year picker) counts only the caller's own rep
 * plus anyone they manage.
 *
 * Same invoice_status staleness caveat as repPerformance.ts applies here,
 * more directly: the entire Uninvoiced Orders list is invoice_status-driven
 * (see qbwc/orderInvoiceStatus.ts), so a stale linked_txn can hide an order
 * that's actually been invoiced, or show one as open past its real billing.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission, reportRepScope } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('orderToCash:read'));

// Booked but not (or only partly) billed — the two statuses that mean the
// order still owes an invoice. 'Closed' is excluded on purpose: a manually
// closed order isn't sitting in limbo, it's been written off.
const OPEN_STATUSES = `('Not Invoiced', 'Partially Invoiced')`;

app.get('/summary', async (c) => {
  const limitParam = parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 100;

  // Default: the current year. Only an explicit year=all opts out (null here
  // = no year filter in every query below).
  const yearParam = c.req.query('year');
  const parsedYear = parseInt(yearParam ?? '', 10);
  const year = yearParam === 'all' ? null
    : Number.isFinite(parsedYear) ? parsedYear
    : new Date().getFullYear();
  // null at `all` scope; the caller's own + managed reps at `own`.
  const scope = reportRepScope(c, 'orderToCash:read');

  const [openSummary, uninvoiced, collectionSpeed, years] = await Promise.all([
    execQuery(
      c.env,
      `SELECT COALESCE(SUM(total), 0)::numeric AS value, COUNT(*)::int AS count
         FROM public.qb_sales_order
        WHERE qb_deleted_at IS NULL AND invoice_status IN ${OPEN_STATUSES}
          AND ($1::int IS NULL OR extract(year FROM txn_date)::int = $1)
          AND ($2::text[] IS NULL OR sales_rep_list_id = ANY($2::text[]))`,
      [year, scope],
      'orderToCash.openSummary'
    ),
    execQuery(
      c.env,
      `SELECT so.qb_sales_order_id, so.ref_number, so.customer_name, so.txn_date, so.total, so.invoice_status,
              COALESCE(qsr.name, so.sales_rep) AS sales_rep_name,
              (CURRENT_DATE - so.txn_date)::int AS days_open
         FROM public.qb_sales_order so
         LEFT JOIN public.qb_sales_rep qsr ON qsr.list_id = so.sales_rep_list_id
        WHERE so.qb_deleted_at IS NULL AND so.invoice_status IN ${OPEN_STATUSES}
          AND so.txn_date IS NOT NULL
          AND ($2::int IS NULL OR extract(year FROM so.txn_date)::int = $2)
          AND ($3::text[] IS NULL OR so.sales_rep_list_id = ANY($3::text[]))
        ORDER BY so.txn_date ASC
        LIMIT $1`,
      [limit, year, scope],
      'orderToCash.uninvoiced'
    ),
    // Every invoice in scope with at least one applied payment, days from
    // invoice date to the first payment that touched it — company-wide at
    // `all`, the caller's own invoices at `own`.
    execQuery(
      c.env,
      `SELECT AVG(first_pay.pay_date - i.txn_date)::numeric AS avg_days, COUNT(*)::int AS paid_count
         FROM public.qb_invoice i
         JOIN LATERAL (
           SELECT MIN(p.txn_date) AS pay_date
             FROM public.qb_payment p, jsonb_array_elements(COALESCE(p.applied_to, '[]'::jsonb)) elem
            WHERE elem->>'txn_id' = i.txn_id AND elem->>'txn_type' = 'Invoice'
         ) first_pay ON first_pay.pay_date IS NOT NULL
        WHERE i.qb_deleted_at IS NULL
          AND ($1::int IS NULL OR extract(year FROM i.txn_date)::int = $1)
          AND ($2::text[] IS NULL OR i.sales_rep_list_id = ANY($2::text[]))`,
      [year, scope],
      'orderToCash.collectionSpeed'
    ),
    // Every year with sales-order or invoice data, for the picker — union of
    // both since open-orders and collection-speed are dated off different
    // tables.
    execQuery(
      c.env,
      `SELECT DISTINCT y FROM (
         SELECT extract(year FROM txn_date)::int AS y FROM public.qb_sales_order
          WHERE qb_deleted_at IS NULL AND txn_date IS NOT NULL
            AND ($1::text[] IS NULL OR sales_rep_list_id = ANY($1::text[]))
         UNION
         SELECT extract(year FROM txn_date)::int AS y FROM public.qb_invoice
          WHERE qb_deleted_at IS NULL AND txn_date IS NOT NULL
            AND ($1::text[] IS NULL OR sales_rep_list_id = ANY($1::text[]))
       ) years
       ORDER BY y DESC`,
      [scope],
      'orderToCash.years'
    ),
  ]);

  return c.json({
    success: true,
    data: {
      year: year ?? 'all',
      years: years.rows.map((r: any) => r.y),
      openOrders: {
        value: Number(openSummary.rows[0]?.value ?? 0),
        count: openSummary.rows[0]?.count ?? 0,
      },
      uninvoicedOrders: uninvoiced.rows.map((r: any) => ({
        id: r.qb_sales_order_id,
        refNumber: r.ref_number,
        customerName: r.customer_name,
        txnDate: r.txn_date,
        total: Number(r.total ?? 0),
        invoiceStatus: r.invoice_status,
        salesRepName: r.sales_rep_name,
        daysOpen: r.days_open,
      })),
      avgDaysToPay: collectionSpeed.rows[0]?.avg_days != null ? Number(collectionSpeed.rows[0].avg_days) : null,
      paidInvoiceCount: collectionSpeed.rows[0]?.paid_count ?? 0,
      invoiceStatusMayBeStale: true,
    },
  });
});

export default app;
