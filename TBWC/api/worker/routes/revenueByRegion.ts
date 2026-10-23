/**
 * Revenue by Region. Order revenue grouped into the 4
 * US Census regions (Northeast/Midwest/South/West), region derived from each
 * order's shipping address rather than the customer's billing address (reps
 * ship all over; the customer's billing state is often just where their AP
 * department sits).
 *
 * qb_sales_order.ship_address_block is QB's free-text Addr1-5 block (joined
 * with '\n'), not structured fields, and sometimes blank for will-call/pickup
 * orders — so state is parsed out with a regex (the last "XX 12345"-shaped
 * token in the block, which is where City/State/Zip always lands even when
 * trailing junk lines like a phone number follow it) and falls back to
 * bill_address_block when ship is empty. Orders that still can't be parsed
 * (will-call, missing address, a handful of malformed blocks) land in
 * 'Unknown' rather than being dropped, so the total always reconciles.
 *
 * ?year=YYYY filters to that year's orders (txn_date); omit or pass
 * year=all for the all-time view (the default).
 *
 * revenueByRegion:read honours its scope through middleware's reportRepScope,
 * like every other report: at `own` both the region breakdown and the year
 * picker count only the caller's own rep plus anyone they manage, so the
 * percentages read as a share of their own book, not the company's.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission, reportRepScope } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('revenueByRegion:read'));

const REGION_CASE = `
  CASE upper(parsed.state)
    WHEN 'CT' THEN 'Northeast' WHEN 'ME' THEN 'Northeast' WHEN 'MA' THEN 'Northeast'
    WHEN 'NH' THEN 'Northeast' WHEN 'RI' THEN 'Northeast' WHEN 'VT' THEN 'Northeast'
    WHEN 'NJ' THEN 'Northeast' WHEN 'NY' THEN 'Northeast' WHEN 'PA' THEN 'Northeast'
    WHEN 'IL' THEN 'Midwest' WHEN 'IN' THEN 'Midwest' WHEN 'MI' THEN 'Midwest'
    WHEN 'OH' THEN 'Midwest' WHEN 'WI' THEN 'Midwest' WHEN 'IA' THEN 'Midwest'
    WHEN 'KS' THEN 'Midwest' WHEN 'MN' THEN 'Midwest' WHEN 'MO' THEN 'Midwest'
    WHEN 'NE' THEN 'Midwest' WHEN 'ND' THEN 'Midwest' WHEN 'SD' THEN 'Midwest'
    WHEN 'DE' THEN 'South' WHEN 'FL' THEN 'South' WHEN 'GA' THEN 'South'
    WHEN 'MD' THEN 'South' WHEN 'NC' THEN 'South' WHEN 'SC' THEN 'South'
    WHEN 'VA' THEN 'South' WHEN 'DC' THEN 'South' WHEN 'WV' THEN 'South'
    WHEN 'AL' THEN 'South' WHEN 'KY' THEN 'South' WHEN 'MS' THEN 'South'
    WHEN 'TN' THEN 'South' WHEN 'AR' THEN 'South' WHEN 'LA' THEN 'South'
    WHEN 'OK' THEN 'South' WHEN 'TX' THEN 'South'
    WHEN 'AZ' THEN 'West' WHEN 'CO' THEN 'West' WHEN 'ID' THEN 'West'
    WHEN 'MT' THEN 'West' WHEN 'NV' THEN 'West' WHEN 'NM' THEN 'West'
    WHEN 'UT' THEN 'West' WHEN 'WY' THEN 'West' WHEN 'AK' THEN 'West'
    WHEN 'CA' THEN 'West' WHEN 'HI' THEN 'West' WHEN 'OR' THEN 'West'
    WHEN 'WA' THEN 'West'
    ELSE 'Unknown'
  END`;

app.get('/summary', async (c) => {
  const yearParam = c.req.query('year');
  const year = yearParam && yearParam !== 'all' && Number.isFinite(parseInt(yearParam, 10))
    ? parseInt(yearParam, 10)
    : null;
  // null at `all` scope; the caller's own + managed reps at `own`.
  const scope = reportRepScope(c, 'revenueByRegion:read');

  const [byRegion, years] = await Promise.all([
    execQuery(
      c.env,
      `SELECT region, count(*)::int AS orders, COALESCE(sum(total), 0)::numeric AS revenue
         FROM (
           SELECT so.total, ${REGION_CASE} AS region
             FROM public.qb_sales_order so
             LEFT JOIN LATERAL (
               SELECT upper(mm[1]) AS state
                 FROM regexp_matches(
                        COALESCE(so.ship_address_block, so.bill_address_block, ''),
                        '([A-Za-z]{2})\\.?\\s{0,2}\\d{4,5}(?:-\\d{4})?',
                        'g'
                      ) WITH ORDINALITY AS t(mm, ord)
                ORDER BY ord DESC
                LIMIT 1
             ) parsed ON true
            WHERE so.qb_deleted_at IS NULL
              AND ($1::int IS NULL OR extract(year FROM so.txn_date)::int = $1)
              AND ($2::text[] IS NULL OR so.sales_rep_list_id = ANY($2::text[]))
         ) x
         GROUP BY region`,
      [year, scope],
      'revenueByRegion.byRegion'
    ),
    execQuery(
      c.env,
      `SELECT DISTINCT extract(year FROM txn_date)::int AS y
         FROM public.qb_sales_order
        WHERE qb_deleted_at IS NULL AND txn_date IS NOT NULL
          AND ($1::text[] IS NULL OR sales_rep_list_id = ANY($1::text[]))
        ORDER BY y DESC`,
      [scope],
      'revenueByRegion.years'
    ),
  ]);

  const rows = byRegion.rows.map((r: any) => ({
    region: r.region as string,
    orders: Number(r.orders),
    revenue: Number(r.revenue),
  }));
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);

  return c.json({
    success: true,
    data: {
      year: year ?? 'all',
      years: years.rows.map((r: any) => r.y),
      rows: rows
        .map((r) => ({ ...r, pct: totalRevenue > 0 ? (r.revenue * 100) / totalRevenue : 0 }))
        .sort((a, b) => b.revenue - a.revenue),
      totalRevenue,
      totalOrders,
    },
  });
});

export default app;
