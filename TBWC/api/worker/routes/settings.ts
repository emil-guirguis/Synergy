/**
 * Company settings — org info + system config shown on the Settings page.
 * Singleton table (one row); admin-only, same as customers/inventory.
 * Row<->shape mapping lives in the framework base module so it stays
 * identical to MeterItPro's settings shape — see
 * framework/backend/api/base/settings.ts.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { rowToBasicSettings, basicSettingsToRow } from '@meterit/framework-backend/api/base/settings';
import {
  latestRunPerJob, recentRuns, avgDurationPerJob,
  listScheduledJobs, setJobTier, jobTier, type CronTier,
} from '../cronMonitor';
import {
  BACKUP_BUCKETS, backupStorageToSupabase, storageBackupStatus,
  restoreObjectFromBackup, restoreBucketBatch,
  backupPauseState, setBackupPaused,
  verifyBackupBatch, verifyBackupTotal, VERIFY_JOB_NAME,
} from '../storageBackup';
import { recentRunsForJob, runJob, logCompletedRun } from '../cronMonitor';
import { JOB_REGISTRY } from '../jobRegistry';
import {
  streamDatabaseDump, listLiveStorageObjects, restoreObjectToLiveBucket, listManagedBackups,
} from '../backupExport';
import { fetchDocumentBytes } from '@meterit/framework-backend/api/base/aiSearch';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authenticateToken);

const TABLE = 'company_settings';
const PK = 'company_settings_id';

async function loadRow(env: Env) {
  const result = await execQuery(
    env,
    `SELECT * FROM public.${TABLE} ORDER BY ${PK} LIMIT 1`,
    [],
    'settings.load'
  );
  return result.rows[0] ?? null;
}

app.get('/', requirePermission('setting:read'), async (c) => {
  const row = await loadRow(c.env);
  if (!row) return c.json({ success: false, message: 'Settings not found' }, 404);
  return c.json({ success: true, data: rowToBasicSettings(row) });
});

app.put('/', requirePermission('setting:write'), async (c) => {
  const existing = await loadRow(c.env);
  if (!existing) return c.json({ success: false, message: 'Settings not found' }, 404);

  const body = await c.req.json();
  const updateData = basicSettingsToRow(body);
  if (Object.keys(updateData).length === 0) {
    return c.json({ success: true, data: rowToBasicSettings(existing) });
  }

  const setClause: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(updateData)) {
    setClause.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  setClause.push('updated_at = NOW()');
  values.push(existing[PK]);

  const result = await execQuery(
    c.env,
    `UPDATE public.${TABLE} SET ${setClause.join(', ')} WHERE ${PK} = $${idx} RETURNING *`,
    values,
    'settings.update'
  );

  return c.json({
    success: true,
    data: rowToBasicSettings(result.rows[0]),
    message: 'Settings updated successfully',
  });
});

// --- Scheduled Jobs tab: worker/cronMonitor.ts's cron_run_log + alert_setting
// (migration 102) — see worker/qbwc/staleAlert.ts for the one check reading
// alert_setting today. ---------------------------------------------------

app.get('/cron-log', requirePermission('setting:read'), async (c) => {
  const [latest, recent, avg, jobs] = await Promise.all([
    latestRunPerJob(c.env),
    recentRuns(c.env, 100),
    avgDurationPerJob(c.env, 24),
    listScheduledJobs(c.env),
  ]);
  return c.json({ success: true, data: { latest, recent, avg, jobs } });
});

// Last 7 days for one job — backs the Scheduled Jobs drawer's history table
// (same query storage-backup/history already uses for 'backupStorage').
app.get('/cron-log/:jobName/history', requirePermission('setting:read'), async (c) => {
  const runs = await recentRunsForJob(c.env, c.req.param('jobName'), 7);
  return c.json({ success: true, data: runs });
});

// Runs any JOB_REGISTRY job right now instead of waiting for its tier's next
// tick — Scheduled Jobs drawer's "Run now". Refuses a job parked on 'off'
// (migration 107's stop switch) for the same reason storage-backup/run
// already does: a job the admin explicitly stopped shouldn't run just
// because someone clicked a different button.
app.post('/jobs/:jobName/run', requirePermission('setting:write'), async (c) => {
  const jobName = c.req.param('jobName');
  const fn = JOB_REGISTRY[jobName];
  if (!fn) return c.json({ success: false, message: `Unknown job "${jobName}"` }, 404);
  if ((await jobTier(c.env, jobName)) === 'off') {
    return c.json({ success: false, message: 'This job is stopped — resume its schedule before running it' }, 409);
  }
  await runJob(c.env, jobName, () => fn(c.env, new Date()));
  // recentRunsForJob orders newest first — [0] is the run that just finished.
  const [run] = await recentRunsForJob(c.env, jobName, 7);
  return c.json({ success: true, data: run ?? null });
});

// 'off' is a valid choice, not a tier that runs — see migration 107.
const VALID_TIERS: CronTier[] = ['frequent', 'hourly', 'daily', 'nightly', 'off'];

app.put('/jobs/:jobName', requirePermission('setting:write'), async (c) => {
  const jobName = c.req.param('jobName');
  const body = await c.req.json();
  const tier = body.cron_tier;
  if (!VALID_TIERS.includes(tier)) {
    return c.json({ success: false, message: `cron_tier must be one of: ${VALID_TIERS.join(', ')}` }, 400);
  }
  const updated = await setJobTier(c.env, jobName, tier);
  if (!updated) return c.json({ success: false, message: `No scheduled_job row for "${jobName}"` }, 404);
  return c.json({ success: true, data: updated, message: 'Schedule updated' });
});

app.get('/alerts', requirePermission('setting:read'), async (c) => {
  const result = await execQuery(
    c.env,
    `SELECT alert_setting_id, alert_key, enabled, notify_email, notify_inapp, threshold_minutes,
            throttle_hours, recipient_permission, recipient_user_ids, updated_at
       FROM public.alert_setting
      ORDER BY alert_key`,
    [],
    'settings.alerts.list'
  );
  return c.json({ success: true, data: result.rows });
});

const ALERT_SETTING_COLUMNS = [
  'enabled', 'notify_email', 'notify_inapp', 'threshold_minutes',
  'throttle_hours', 'recipient_permission', 'recipient_user_ids',
];

app.put('/alerts/:alertKey', requirePermission('setting:write'), async (c) => {
  const alertKey = c.req.param('alertKey');
  const body = await c.req.json();
  const updateData: Record<string, any> = {};
  for (const col of ALERT_SETTING_COLUMNS) {
    if (col in body) updateData[col] = body[col];
  }
  if (Object.keys(updateData).length === 0) {
    return c.json({ success: false, message: 'No recognized fields in request body' }, 400);
  }

  const setClause: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(updateData)) {
    setClause.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  setClause.push('updated_at = NOW()');
  values.push(alertKey);

  const result = await execQuery(
    c.env,
    `UPDATE public.alert_setting SET ${setClause.join(', ')} WHERE alert_key = $${idx} RETURNING *`,
    values,
    'settings.alerts.update'
  );
  if (!result.rows[0]) return c.json({ success: false, message: `No alert_setting row for "${alertKey}"` }, 404);
  return c.json({ success: true, data: result.rows[0], message: 'Alert setting updated' });
});

// --- Storage Backup tab: worker/storageBackup.ts's mirror of Supabase
// Storage object bytes into a second bucket in this same project (migration
// 105/109). The mirror job itself ('backupStorage')
// already shows up in the Scheduled Jobs tab above via cron_run_log — these
// endpoints are the per-bucket progress + the manual run/restore actions. ---

function isBackupBucket(v: unknown): v is (typeof BACKUP_BUCKETS)[number] {
  return typeof v === 'string' && (BACKUP_BUCKETS as readonly string[]).includes(v);
}

app.get('/storage-backup', requirePermission('setting:read'), async (c) => {
  const [buckets, pause] = await Promise.all([storageBackupStatus(c.env), backupPauseState(c.env)]);
  return c.json({ success: true, data: { buckets, ...pause } });
});

// Last 7 days of the two document-backup jobs (dates/times/status) —
// job-specific, not the shared 100-row recentRuns() a frequent-tier job
// elsewhere would crowd out. Verification runs are merged in rather than
// given their own table: they are runs against the same mirror, and a
// "nothing copied" sweep reads very differently next to the verification pass
// that proves the mirror is actually intact. Callers tell them apart by
// job_name, which CronRunRow already carries.
app.get('/storage-backup/history', requirePermission('setting:read'), async (c) => {
  const [sweeps, verifications] = await Promise.all([
    recentRunsForJob(c.env, 'backupStorage', 7),
    recentRunsForJob(c.env, VERIFY_JOB_NAME, 7),
  ]);
  const runs = [...sweeps, ...verifications].sort(
    (a, b) => +new Date(b.started_at) - +new Date(a.started_at)
  );
  return c.json({ success: true, data: runs });
});

// Runs one batch immediately (same bounded-per-call shape as the scheduled
// tick) rather than waiting for the next tier tick — "back up now". Wrapped
// in runJob() like the cron-triggered path, so a manual run shows up in the
// history table (storage-backup/history below) too, not just ticks.
//
// One call can NOT drain a whole backlog, and no amount of tuning changes
// that: Cloudflare caps a single invocation at 1000 subrequests, and every
// object costs one Supabase object/copy fetch — so ~900-1000 objects is the
// hard per-call ceiling however long the budget is (storageBackup.ts's
// MAX_TICK_MILLIS is already sized to land just under it). The "back up
// everything in one click" the Settings panel offers is therefore a loop on
// the CLIENT side, re-POSTing here until nothing's pending — which is why
// this returns the run's own `detail` (copied/failed/stopped) and not just
// the refreshed status: the caller needs to know whether a call made
// progress, so a backlog of objects that fail every time (bad source bytes,
// say) ends the loop instead of spinning on it forever.
app.post('/storage-backup/run', requirePermission('setting:write'), async (c) => {
  // Refused rather than silently no-op'ing: backupStorageToSupabase itself
  // also bails when paused (so a stop is honoured no matter the entry
  // point), but a manual run that quietly copied nothing would read as a
  // broken button.
  const pause = await backupPauseState(c.env);
  if (pause.paused) {
    return c.json({ success: false, message: 'Backup is stopped — resume it before running a batch' }, 409);
  }
  const detail = await runJob(c.env, 'backupStorage', () => backupStorageToSupabase(c.env));
  const buckets = await storageBackupStatus(c.env);
  return c.json({ success: true, data: { buckets, ...(await backupPauseState(c.env)), detail } });
});

// Verifies one cursor-paged slice of the mirror and repairs what it finds
// wrong — the backward pass the incremental sweep can't do, see
// storageBackup.ts's Verification section. Paged for the same reason the
// sweep is: one ranged GET per object against a per-invocation subrequest cap
// that runs out well before 12k objects, so the panel calls this in a loop
// until `cursor` comes back null.
//
// setting:write, not setting:read: a failed check deletes the rotten mirror
// object and its ledger row so the next sweep re-copies the file properly.
// Allowed while the backup is paused (unlike /run), since the check itself is
// read-only against live storage and the repairs are what a later resume
// acts on — but the panel says so, because nothing gets re-copied until then.
app.post('/storage-backup/verify', requirePermission('setting:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cursor = typeof body.cursor === 'string' ? body.cursor : null;
  try {
    const result = await verifyBackupBatch(c.env, cursor);
    // Only on the first call: the panel needs a denominator for its progress
    // bar, and re-counting the whole ledger on every call in the loop would
    // be a wasted query per batch.
    const total = cursor ? undefined : await verifyBackupTotal(c.env);
    return c.json({ success: true, data: { ...result, ...(total === undefined ? {} : { total }) } });
  } catch (e) {
    return c.json({ success: false, message: e instanceof Error ? e.message : 'Verification failed' }, 500);
  }
});

// The stop/start switch. Writes scheduled_job.cron_tier ('off' <-> 'nightly'),
// which both keeps future cron ticks from running the job and makes a run
// already in progress bail at its next batch boundary (storageBackup.ts).
app.post('/storage-backup/pause', requirePermission('setting:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.paused !== 'boolean') {
    return c.json({ success: false, message: 'paused (boolean) is required' }, 400);
  }
  try {
    const pause = await setBackupPaused(c.env, body.paused);
    const buckets = await storageBackupStatus(c.env);
    return c.json({
      success: true,
      data: { buckets, ...pause },
      message: pause.paused ? 'Backup stopped' : 'Backup resumed',
    });
  } catch (e) {
    return c.json({ success: false, message: e instanceof Error ? e.message : 'Failed to change backup state' }, 500);
  }
});

// Restores one object — the common "I deleted/corrupted this one file" case.
app.post('/storage-backup/restore', requirePermission('setting:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isBackupBucket(body.bucket)) {
    return c.json({ success: false, message: `bucket must be one of: ${BACKUP_BUCKETS.join(', ')}` }, 400);
  }
  if (typeof body.path !== 'string' || !body.path) {
    return c.json({ success: false, message: 'path is required' }, 400);
  }
  try {
    await restoreObjectFromBackup(c.env, body.bucket, body.path);
    return c.json({ success: true, message: `Restored ${body.bucket}/${body.path}` });
  } catch (e) {
    return c.json({ success: false, message: e instanceof Error ? e.message : 'Restore failed' }, 500);
  }
});

// Restores a whole bucket from the mirror, one cursor-paged batch per call —
// the panel calls this in a loop until `cursor` comes back null. For
// disaster-recovery use (bucket wiped/corrupted wholesale), not routine.
app.post('/storage-backup/restore-bucket', requirePermission('setting:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isBackupBucket(body.bucket)) {
    return c.json({ success: false, message: `bucket must be one of: ${BACKUP_BUCKETS.join(', ')}` }, 400);
  }
  try {
    const result = await restoreBucketBatch(c.env, body.bucket, body.cursor ?? null);
    return c.json({ success: true, data: result });
  } catch (e) {
    return c.json({ success: false, message: e instanceof Error ? e.message : 'Restore failed' }, 500);
  }
});

// --- Backup tab (renamed from Storage Backup — now also covers the DB and
// a disk/external-drive path): worker/backupExport.ts. Independent of the
// Supabase-to-Supabase mirror above, which keeps running untouched. ---------

// Database: one streamed NDJSON response, browser-saved wherever the user
// picks (showSaveFilePicker lets that be an external drive). Logs its own
// cron_run_log row from inside the stream — see streamDatabaseDump.
app.get('/backup/database', requirePermission('setting:read'), (c) => {
  const stream = streamDatabaseDump(c.env);
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="tbwc-db-${new Date().toISOString().slice(0, 10)}.ndjson"`,
    },
  });
});

// Supabase's own daily managed Postgres backups — read-only, nothing copied.
app.get('/backup/managed', requirePermission('setting:read'), async (c) => {
  return c.json({ success: true, data: await listManagedBackups(c.env) });
});

// Storage: paged listing + one-object transfer, driven in a loop by the
// panel (File System Access API) so 14+ GB never has to pass through a
// single Worker invocation or sit in memory at once.
app.get('/backup/storage/list', requirePermission('setting:read'), async (c) => {
  const bucket = c.req.query('bucket');
  if (!isBackupBucket(bucket)) return c.json({ success: false, message: `bucket must be one of: ${BACKUP_BUCKETS.join(', ')}` }, 400);
  const limit = Math.min(Number(c.req.query('limit') ?? 500) || 500, 1000);
  const result = await listLiveStorageObjects(c.env, bucket, c.req.query('cursor') ?? null, limit);
  return c.json({ success: true, data: result });
});

app.get('/backup/storage/object', requirePermission('setting:read'), async (c) => {
  const bucket = c.req.query('bucket');
  const path = c.req.query('path');
  if (!isBackupBucket(bucket) || !path) return c.json({ success: false, message: 'bucket and path are required' }, 400);
  const bytes = await fetchDocumentBytes(c.env, bucket, path);
  if (bytes === null) return c.json({ success: false, message: 'Object not found or unreadable' }, 404);
  return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
});

// Restore direction: re-uploads one file from a chosen local folder back
// into the LIVE bucket (not the mirror) — overwrites whatever is there now.
app.post('/backup/storage/object', requirePermission('setting:write'), async (c) => {
  const bucket = c.req.query('bucket');
  const path = c.req.query('path');
  if (!isBackupBucket(bucket) || !path) return c.json({ success: false, message: 'bucket and path are required' }, 400);
  try {
    await restoreObjectToLiveBucket(c.env, bucket, path, await c.req.arrayBuffer());
    return c.json({ success: true, message: `Restored ${bucket}/${path}` });
  } catch (e) {
    return c.json({ success: false, message: e instanceof Error ? e.message : 'Restore failed' }, 500);
  }
});

// The storage export/restore loop runs in the browser, not the Worker — it
// reports its own outcome once the loop ends via logCompletedRun, rather
// than the Worker timing a function it never actually ran.
app.post('/backup/log', requirePermission('setting:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // verifyBackup rides this endpoint too: its loop also runs in the browser
  // (one HTTP call per batch), so the Worker never sees the pass as a whole
  // and can't time it with runJob the way a cron job is timed.
  const ALLOWED = ['exportStorage', 'restoreStorage', VERIFY_JOB_NAME];
  if (!ALLOWED.includes(body.job_name)) {
    return c.json({ success: false, message: `job_name must be one of: ${ALLOWED.join(', ')}` }, 400);
  }
  await logCompletedRun(
    c.env,
    body.job_name,
    body.status === 'error' ? 'error' : 'ok',
    body.detail ?? null,
    body.duration_ms ?? null,
    body.error ?? null
  );
  return c.json({ success: true });
});

// Combined history for all three — same 7-day window as storage-backup/history
// above, since pruneCronRunLog deletes every job_name's rows past 7 days
// regardless of what any one caller asks for.
app.get('/backup/history', requirePermission('setting:read'), async (c) => {
  const [db, storageExport, storageRestore] = await Promise.all([
    recentRunsForJob(c.env, 'exportDatabase', 7),
    recentRunsForJob(c.env, 'exportStorage', 7),
    recentRunsForJob(c.env, 'restoreStorage', 7),
  ]);
  const all = [...db, ...storageExport, ...storageRestore].sort(
    (a, b) => +new Date(b.started_at) - +new Date(a.started_at)
  );
  return c.json({ success: true, data: all });
});

export default app;
