/**
 * QB Sync dashboard API — read-only views over public.qbwc_sync_run plus live
 * row counts of the qb_* staging tables. Admin-only (mounted at /api/qb-sync,
 * separate from the unauthenticated /qbwc SOAP endpoint).
 *
 *   GET  /summary  -> latest run per object+direction, staging table totals,
 *                     and any queued full reload per object
 *   GET  /runs     -> recent run log, paged (optional ?object_type= filter, ?limit=, ?offset=)
 *   POST /reload   -> queue a full re-pull of one object type (see below)
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';
import { requestFullReload } from '../qbwc/pullCursor';
import { registry } from '../qbwc/objects';

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

/** Object types the QBWC session actually pulls incrementally — the only ones a
 *  reload can be queued for. Derived from the registry rather than listed again
 *  here: a type offered for reload that the session can't mark drained would
 *  stay stuck in "reload queued" forever. */
const RELOADABLE = new Set(registry.filter((o) => o.incremental).map((o) => o.name));

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

  // Queued full reloads, so the dashboard can show which tables are waiting on
  // the next Web Connector run.
  const cursors = await execQuery(
    c.env,
    `SELECT object_type, full_reload_requested_at, drain_pending
     FROM public.qbwc_pull_cursor`,
    [],
    'qbSync.summary.cursors'
  );
  const reloads: Record<string, string | null> = {};
  for (const r of cursors.rows) {
    reloads[r.object_type] = r.full_reload_requested_at
      ? new Date(r.full_reload_requested_at).toISOString()
      : null;
  }

  return c.json({ success: true, data: { latest: latest.rows, totals, reloads } });
});

/**
 * Queue a full re-pull of one object type. The next QBWC session drops that
 * object's incremental date filter, so QB re-sends every record; the flag
 * clears only once the iterator is confirmed fully drained, so an interrupted
 * reload simply runs again.
 *
 * Non-destructive by construction. Each staging upsert is
 * ON CONFLICT (list_id|txn_id) DO UPDATE naming only QB-owned columns, and no
 * pull ever deletes a staging row — so TBWC-owned data survives untouched:
 * qb_item.image_url/notes/type and the rest of the inventory extras, the
 * order's build_notes/expedite/service/commission/..., and every FK pointing at
 * these rows (documents, kit_items, quote_line), since the surrogate PKs are
 * preserved by the conflict target.
 *
 * Deletions are not part of this: the listDeleted/txnDeleted sweeps run every
 * session regardless, and QB's deleted-object log only reaches back ~90 days.
 *
 * This does not itself contact QuickBooks — the Web Connector drives that on
 * its own schedule (or on a manual "Update Selected" run).
 */
app.post('/reload', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const objectType = typeof body?.object_type === 'string' ? body.object_type : '';
  if (!RELOADABLE.has(objectType)) {
    return c.json(
      { success: false, message: `Unknown object type for reload: ${objectType || '(none)'}` },
      400
    );
  }
  await requestFullReload(c.env, objectType);
  return c.json({
    success: true,
    data: { object_type: objectType, queued_at: new Date().toISOString() },
    message: `Full reload queued for ${objectType}. It runs on the next QuickBooks Web Connector update.`,
  });
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
