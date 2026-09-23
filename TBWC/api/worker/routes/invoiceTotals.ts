/**
 * Invoice Totals report — admin dashboard: current period vs. the previous
 * period vs. the same period last year (three cards), plus a trend line —
 * all driven by one granularity filter (day/week/month/quarter/year/custom)
 * and an optional sales rep filter. No year picker — "current" is always
 * anchored to today; picking "Yearly" is how you get the old
 * YTD-vs-last-year-YTD view (where "previous" and "same period last year"
 * happen to coincide). "Custom" takes an explicit from/to range instead.
 *
 * Every card's total/count comes with the exact from/to dates that produced
 * it, so the frontend can send a click straight to the Invoices list
 * filtered to that same range (see invoices.ts's whereRange wiring) — the
 * report never invents a date range the caller can't also see and drill into.
 *
 * Every query excludes total=0 invoices (QB credit/adjustment placeholders) —
 * they'd otherwise inflate invoice counts without moving the dollar total,
 * and drown out genuine activity in a low-volume window like a single week.
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

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
type FixedGranularity = Exclude<Granularity, 'custom'>;

export function parseGranularity(value: string | undefined): Granularity {
  return value === 'day' || value === 'month' || value === 'quarter' || value === 'year' || value === 'custom'
    ? value
    : 'week';
}

// "Weekly" buckets run Friday-to-Friday (not the ISO Monday week) — shift
// back to the most recent Friday by hand rather than using date_trunc.
function fridayWeekStart(d: Date): Date {
  const daysSinceFriday = (d.getUTCDay() - 5 + 7) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceFriday));
}

function bucketStart(d: Date, period: FixedGranularity): Date {
  switch (period) {
    case 'day':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    case 'week':
      return fridayWeekStart(d);
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    case 'quarter':
      return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
    case 'year':
      return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  }
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

// Month-based shift (not a fixed day count) so "1 month/quarter/year back"
// lands on the same day-of-month rather than drifting with month length —
// JS normalizes an out-of-range month (e.g. month -1) into the prior year.
function shiftMonths(d: Date, deltaMonths: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + deltaMonths, d.getUTCDate()));
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const UNIT_MONTHS: Record<FixedGranularity, number> = { day: 0, week: 0, month: 1, quarter: 3, year: 12 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CUSTOM_DEFAULT_SPAN_DAYS = 30; // last 30 days when no from/to given
const CUSTOM_MAX_SPAN_DAYS = 366; // guard against an unbounded trend query

/** Parses ?from=&to= for period=custom — defaults to the last 30 days, swaps a reversed pair, and caps the span at 366 days by pulling `from` forward. */
export function parseCustomRange(fromParam: string | undefined, toParam: string | undefined, now: Date): { from: Date; to: Date } {
  const to = toParam && DATE_RE.test(toParam) ? new Date(`${toParam}T00:00:00Z`) : now;
  let from = fromParam && DATE_RE.test(fromParam) ? new Date(`${fromParam}T00:00:00Z`) : addDays(to, -(CUSTOM_DEFAULT_SPAN_DAYS - 1));
  let start = from <= to ? from : to;
  const end = from <= to ? to : from;
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000);
  if (spanDays > CUSTOM_MAX_SPAN_DAYS) start = addDays(end, -CUSTOM_MAX_SPAN_DAYS);
  return { from: start, to: end };
}

/**
 * Three comparable windows, each [start, end] inclusive:
 *  - current: the bucket containing `now` (or the given custom range)
 *  - previous: exactly one bucket back (yesterday/last week/month/quarter/
 *    year, or an equal-length range immediately before a custom one)
 *  - priorYear: exactly one year back (364 days — 52 whole weeks, so the
 *    Friday anchor survives — for "week"; a calendar year otherwise)
 * For period="year", `previous` and `priorYear` land on the same window
 * (one year back either way) — that's expected, not a bug.
 */
export function periodWindows(period: Granularity, now: Date, customRange?: { from: Date; to: Date }) {
  if (period === 'custom') {
    const { from, to } = customRange ?? parseCustomRange(undefined, undefined, now);
    const spanDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    const previousEnd = addDays(from, -1);
    const previousStart = addDays(previousEnd, -(spanDays - 1));
    return {
      currentStart: toDateStr(from),
      currentEnd: toDateStr(to),
      previousStart: toDateStr(previousStart),
      previousEnd: toDateStr(previousEnd),
      priorYearStart: toDateStr(shiftMonths(from, -12)),
      priorYearEnd: toDateStr(shiftMonths(to, -12)),
    };
  }

  const currentStart = bucketStart(now, period);

  const previousEnd =
    period === 'day' ? addDays(now, -1) : period === 'week' ? addDays(now, -7) : shiftMonths(now, -UNIT_MONTHS[period]);
  const previousStart = bucketStart(previousEnd, period);

  const priorYearEnd = period === 'week' ? addDays(now, -364) : shiftMonths(now, -12);
  const priorYearStart = bucketStart(priorYearEnd, period);

  return {
    currentStart: toDateStr(currentStart),
    currentEnd: toDateStr(now),
    previousStart: toDateStr(previousStart),
    previousEnd: toDateStr(previousEnd),
    priorYearStart: toDateStr(priorYearStart),
    priorYearEnd: toDateStr(priorYearEnd),
  };
}

app.get('/summary', async (c) => {
  const period = parseGranularity(c.req.query('period'));
  const repId = c.req.query('repId') || null;
  const customRange = period === 'custom' ? parseCustomRange(c.req.query('from'), c.req.query('to'), new Date()) : undefined;
  const windows = periodWindows(period, new Date(), customRange);

  const [totals, reps] = await Promise.all([
    execQuery(
      c.env,
      `SELECT
         COALESCE(SUM(total) FILTER (WHERE txn_date::date BETWEEN $1::date AND $2::date), 0)::numeric AS current_total,
         COUNT(*) FILTER (WHERE txn_date::date BETWEEN $1::date AND $2::date)::int AS current_count,
         COALESCE(SUM(total) FILTER (WHERE txn_date::date BETWEEN $3::date AND $4::date), 0)::numeric AS previous_total,
         COUNT(*) FILTER (WHERE txn_date::date BETWEEN $3::date AND $4::date)::int AS previous_count,
         COALESCE(SUM(total) FILTER (WHERE txn_date::date BETWEEN $5::date AND $6::date), 0)::numeric AS prior_year_total,
         COUNT(*) FILTER (WHERE txn_date::date BETWEEN $5::date AND $6::date)::int AS prior_year_count
         FROM public.qb_invoice
        WHERE qb_deleted_at IS NULL
          AND total <> 0
          AND ($7::text IS NULL OR sales_rep_list_id = $7)`,
      [
        windows.currentStart, windows.currentEnd,
        windows.previousStart, windows.previousEnd,
        windows.priorYearStart, windows.priorYearEnd,
        repId,
      ],
      'invoiceTotals.summary'
    ),
    // Active reps for the rep filter dropdown.
    execQuery(
      c.env,
      `SELECT list_id, name FROM public.qb_sales_rep WHERE is_active = true AND qb_deleted_at IS NULL ORDER BY name`,
      [],
      'invoiceTotals.reps'
    ),
  ]);

  const row = totals.rows[0] ?? {};
  return c.json({
    success: true,
    data: {
      period,
      repId,
      reps: reps.rows,
      current: {
        total: Number(row.current_total ?? 0), count: row.current_count ?? 0,
        from: windows.currentStart, to: windows.currentEnd,
      },
      previous: {
        total: Number(row.previous_total ?? 0), count: row.previous_count ?? 0,
        from: windows.previousStart, to: windows.previousEnd,
      },
      priorYear: {
        total: Number(row.prior_year_total ?? 0), count: row.prior_year_count ?? 0,
        from: windows.priorYearStart, to: windows.priorYearEnd,
      },
    },
  });
});

const TREND_DEFAULT_LIMIT: Record<FixedGranularity, number> = { day: 30, week: 26, month: 24, quarter: 8, year: 10 };
const TREND_MAX_LIMIT: Record<FixedGranularity, number> = { day: 180, week: 104, month: 60, quarter: 40, year: 20 };

// Trend line: invoice totals bucketed by period. Fixed granularities take the
// most recent N buckets; "custom" buckets by day across the given range.
app.get('/timeseries', async (c) => {
  const period = parseGranularity(c.req.query('period'));
  const repId = c.req.query('repId') || null;

  if (period === 'custom') {
    const { from, to } = parseCustomRange(c.req.query('from'), c.req.query('to'), new Date());
    const result = await execQuery(
      c.env,
      `SELECT bucket_start, total, count FROM (
         SELECT txn_date::date AS bucket_start,
                SUM(total)::numeric AS total,
                COUNT(*)::int AS count
           FROM public.qb_invoice
          WHERE qb_deleted_at IS NULL
            AND total <> 0
            AND txn_date::date BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR sales_rep_list_id = $3)
          GROUP BY bucket_start
       ) recent
       ORDER BY bucket_start ASC`,
      [toDateStr(from), toDateStr(to), repId],
      'invoiceTotals.timeseries.custom'
    );
    return c.json({
      success: true,
      data: {
        period,
        repId,
        points: result.rows.map((r: any) => ({
          bucketStart: r.bucket_start,
          total: Number(r.total ?? 0),
          count: r.count ?? 0,
        })),
      },
    });
  }

  const limitParam = parseInt(c.req.query('limit') ?? '', 10);
  const limit = Math.min(
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : TREND_DEFAULT_LIMIT[period],
    TREND_MAX_LIMIT[period]
  );

  const bucketExpr =
    period === 'day'
      ? `txn_date::date`
      : period === 'week'
        ? `(date_trunc('week', txn_date - interval '4 days') + interval '4 days')::date`
        : period === 'month'
          ? `date_trunc('month', txn_date)::date`
          : period === 'quarter'
            ? `date_trunc('quarter', txn_date)::date`
            : `date_trunc('year', txn_date)::date`;

  const result = await execQuery(
    c.env,
    `SELECT bucket_start, total, count FROM (
       SELECT ${bucketExpr} AS bucket_start,
              SUM(total)::numeric AS total,
              COUNT(*)::int AS count
         FROM public.qb_invoice
        WHERE qb_deleted_at IS NULL
          AND txn_date IS NOT NULL
          AND total <> 0
          AND ($1::text IS NULL OR sales_rep_list_id = $1)
        GROUP BY bucket_start
        ORDER BY bucket_start DESC
        LIMIT $2
     ) recent
     ORDER BY bucket_start ASC`,
    [repId, limit],
    'invoiceTotals.timeseries'
  );

  return c.json({
    success: true,
    data: {
      period,
      repId,
      points: result.rows.map((r: any) => ({
        bucketStart: r.bucket_start,
        total: Number(r.total ?? 0),
        count: r.count ?? 0,
      })),
    },
  });
});

export default app;
