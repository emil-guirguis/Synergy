/**
 * Invoice Totals report — admin dashboard: total invoiced this year-to-date
 * vs. the same period last year, optionally filtered to one sales rep.
 * "YTD" is compared on a same-day-of-year cutoff (not full calendar years),
 * so a selected year still in progress is compared fairly against the prior
 * year's matching partial period rather than its completed total.
 *
 * Single aggregate endpoint, not a CRUD module — same shape as
 * repPerformance.ts and invoices.ts's receivables-summary.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('report:read'));

app.get('/summary', async (c) => {
  const yearParam = parseInt(c.req.query('year') ?? '', 10);
  const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();
  const repId = c.req.query('repId') || null;

  const [current, prior, years, reps] = await Promise.all([
    execQuery(
      c.env,
      `SELECT COALESCE(SUM(total), 0)::numeric AS total, COUNT(*)::int AS count
         FROM public.qb_invoice
        WHERE qb_deleted_at IS NULL
          AND extract(year FROM txn_date)::int = $1
          AND extract(doy FROM txn_date)::int <= extract(doy FROM LEAST(CURRENT_DATE, make_date($1, 12, 31)))::int
          AND ($2::text IS NULL OR sales_rep_list_id = $2)`,
      [year, repId],
      'invoiceTotals.current'
    ),
    execQuery(
      c.env,
      `SELECT COALESCE(SUM(total), 0)::numeric AS total, COUNT(*)::int AS count
         FROM public.qb_invoice
        WHERE qb_deleted_at IS NULL
          AND extract(year FROM txn_date)::int = $1 - 1
          AND extract(doy FROM txn_date)::int <= extract(doy FROM LEAST(CURRENT_DATE, make_date($1, 12, 31)))::int
          AND ($2::text IS NULL OR sales_rep_list_id = $2)`,
      [year, repId],
      'invoiceTotals.prior'
    ),
    // Every year with invoice data, for the year dropdown — same pattern as
    // invoices.ts's receivables-summary.
    execQuery(
      c.env,
      `SELECT DISTINCT extract(year FROM txn_date)::int AS y
         FROM public.qb_invoice
        WHERE qb_deleted_at IS NULL AND txn_date IS NOT NULL
        ORDER BY y DESC`,
      [],
      'invoiceTotals.years'
    ),
    // Active reps for the rep filter dropdown.
    execQuery(
      c.env,
      `SELECT list_id, name FROM public.qb_sales_rep WHERE is_active = true ORDER BY name`,
      [],
      'invoiceTotals.reps'
    ),
  ]);

  return c.json({
    success: true,
    data: {
      year,
      years: years.rows.map((r: any) => r.y),
      repId,
      reps: reps.rows,
      current: { total: Number(current.rows[0]?.total ?? 0), count: current.rows[0]?.count ?? 0 },
      prior: { total: Number(prior.rows[0]?.total ?? 0), count: prior.rows[0]?.count ?? 0 },
    },
  });
});

export default app;
