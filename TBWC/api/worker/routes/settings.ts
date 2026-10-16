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
  listScheduledJobs, setJobTier, type CronTier,
} from '../cronMonitor';
import {
  BACKUP_BUCKETS, backupStorageToR2, storageBackupStatus,
  restoreObjectFromR2, restoreBucketBatch,
  backupPauseState, setBackupPaused,
} from '../storageBackup';
import { recentRunsForJob, runJob } from '../cronMonitor';

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

// --- Storage Backup tab: worker/storageBackup.ts's R2 mirror of Supabase
// Storage object bytes (migration 105). The mirror job itself ('backupStorage')
// already shows up in the Scheduled Jobs tab above via cron_run_log — these
// endpoints are the per-bucket progress + the manual run/restore actions. ---

function isBackupBucket(v: unknown): v is (typeof BACKUP_BUCKETS)[number] {
  return typeof v === 'string' && (BACKUP_BUCKETS as readonly string[]).includes(v);
}

app.get('/storage-backup', requirePermission('setting:read'), async (c) => {
  const [buckets, pause] = await Promise.all([storageBackupStatus(c.env), backupPauseState(c.env)]);
  return c.json({ success: true, data: { buckets, ...pause } });
});

// Last 7 days of backupStorage runs (dates/times/status) — job-specific, not
// the shared 100-row recentRuns() a frequent-tier job elsewhere would crowd out.
app.get('/storage-backup/history', requirePermission('setting:read'), async (c) => {
  const runs = await recentRunsForJob(c.env, 'backupStorage', 7);
  return c.json({ success: true, data: runs });
});

// Runs one batch immediately (same bounded-per-call shape as the scheduled
// tick) rather than waiting for the next tier tick — "back up now". Wrapped
// in runJob() like the cron-triggered path, so a manual run shows up in the
// history table (storage-backup/history below) too, not just ticks.
app.post('/storage-backup/run', requirePermission('setting:write'), async (c) => {
  // Refused rather than silently no-op'ing: backupStorageToR2 itself also
  // bails when paused (so a stop is honoured no matter the entry point), but
  // a manual run that quietly copied nothing would read as a broken button.
  const pause = await backupPauseState(c.env);
  if (pause.paused) {
    return c.json({ success: false, message: 'Backup is stopped — resume it before running a batch' }, 409);
  }
  await runJob(c.env, 'backupStorage', () => backupStorageToR2(c.env));
  const buckets = await storageBackupStatus(c.env);
  return c.json({ success: true, data: { buckets, ...(await backupPauseState(c.env)) } });
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
    await restoreObjectFromR2(c.env, body.bucket, body.path);
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

export default app;
