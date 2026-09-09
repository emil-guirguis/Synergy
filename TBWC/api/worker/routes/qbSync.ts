/**
 * QB Sync dashboard API — read-only views over public.qbwc_sync_run plus live
 * row counts of the qb_* staging tables. Admin-only (mounted at /api/qb-sync,
 * separate from the unauthenticated /qbwc SOAP endpoint).
 *
 *   GET /summary  -> latest run per object+direction, staging table totals
 *   GET /runs     -> recent run log, paged (optional ?object_type= filter, ?limit=, ?offset=)
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requireAdmin);

/** Staging table per QB object type — for total row counts on the dashboard. */
const STAGING_TABLES: Record<string, string> = {
  Customer: 'qb_customer',
  Vendor: 'qb_vendor',
  SalesRep: 'qb_sales_rep',
  Item: 'qb_item',
  Invoice: 'qb_invoice',
  Payment: 'qb_payment',
  SalesOrder: 'qb_sales_order',
  Estimate: 'qb_estimate',
};

app.get('/summary', async (c) => {
  // Latest logged run per object+direction.
  const latest = await execQuery(
    c.env,
    `SELECT DISTINCT ON (object_type, direction)
       object_type, direction, status_code, rows_processed, error, detail, created_at
     FROM public.qbwc_sync_run
     ORDER BY object_type, direction, created_at DESC`,
    [],
    'qbSync.summary.latest'
  );

  // Live totals in each staging table (table names are from the fixed map above,
  // never user input).
  const countsSql = Object.entries(STAGING_TABLES)
    .map(([obj, table]) => `SELECT '${obj}' AS object_type, COUNT(*)::int AS total FROM public.${table}`)
    .join(' UNION ALL ');
  const counts = await execQuery(c.env, countsSql, [], 'qbSync.summary.counts');

  const totals: Record<string, number> = {};
  for (const r of counts.rows) totals[r.object_type] = r.total;

  return c.json({ success: true, data: { latest: latest.rows, totals } });
});

app.get('/runs', async (c) => {
  const q = c.req.query();
  const limit = Math.min(parseInt(q.limit || '100', 10) || 100, 500);
  const offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);
  const params: any[] = [];
  let where = '';
  if (q.object_type) {
    params.push(q.object_type);
    where = `WHERE object_type = $1`;
  }

  const countR = await execQuery(
    c.env,
    `SELECT COUNT(*)::int AS total FROM public.qbwc_sync_run ${where}`,
    params,
    'qbSync.runs.count'
  );

  params.push(limit, offset);
  const r = await execQuery(
    c.env,
    `SELECT qbwc_sync_run_id, ticket, object_type, direction, status_code,
            rows_processed, error, detail, created_at
     FROM public.qbwc_sync_run
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    'qbSync.runs'
  );
  return c.json({ success: true, data: { items: r.rows, total: countR.rows[0]?.total ?? r.rows.length } });
});

export default app;
