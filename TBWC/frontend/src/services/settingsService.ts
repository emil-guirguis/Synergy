/**
 * Company settings client — org info + system config shown on the Settings
 * page. Admin-only, singleton row (see TBWC/api/worker/routes/settings.ts).
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

export interface CompanySettings {
  name: string;
  address: {
    street: string;
    street2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  contactInfo: {
    url: string;
    email: string;
  };
  systemConfig: {
    timezone: string;
    dateFormat: string;
    timeFormat: string;
    currency: string;
    language: string;
    defaultPageSize: number;
  };
  updatedAt: string | null;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function parse(res: Response) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export async function getSettings(): Promise<CompanySettings> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings`, { headers: authHeaders() }));
  return data.data;
}

export async function updateSettings(updates: Partial<CompanySettings>): Promise<CompanySettings> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(updates),
    })
  );
  return data.data;
}

// --- Scheduled Jobs tab: worker/cronMonitor.ts + worker/qbwc/staleAlert.ts's
// alert_setting (migration 102). ------------------------------------------

export interface CronRun {
  cron_run_log_id: number;
  job_name: string;
  status: 'running' | 'ok' | 'error';
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  /** Job-shaped result of a successful run (e.g. {indexed, attempted} for
   *  backfillDocumentIndex, {copied, failed, stopped} for backupStorage) —
   *  null for 'running'/'error' rows and runs from before migration 108. */
  detail: Record<string, unknown> | null;
}

// 'off' parks a job so it never runs — the stop switch (migration 107), not
// a schedule. See worker/cronMonitor.ts.
export type CronTier = 'frequent' | 'hourly' | 'daily' | 'nightly' | 'off';

export interface ScheduledJob {
  scheduled_job_id: number;
  job_name: string;
  cron_tier: CronTier;
  updated_at: string;
}

export interface CronLog {
  latest: CronRun[];
  recent: CronRun[];
  avg: { job_name: string; avg_ms: number; runs: number }[];
  jobs: ScheduledJob[];
}

export interface AlertSetting {
  alert_setting_id: number;
  alert_key: string;
  enabled: boolean;
  notify_email: boolean;
  notify_inapp: boolean;
  threshold_minutes: number | null;
  throttle_hours: number;
  recipient_permission: string | null;
  recipient_user_ids: string[];
  updated_at: string;
}

export async function getCronLog(): Promise<CronLog> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings/cron-log`, { headers: authHeaders() }));
  return data.data;
}

export async function getAlertSettings(): Promise<AlertSetting[]> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings/alerts`, { headers: authHeaders() }));
  return data.data;
}

export async function updateAlertSetting(alertKey: string, updates: Partial<AlertSetting>): Promise<AlertSetting> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/alerts/${encodeURIComponent(alertKey)}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(updates),
    })
  );
  return data.data;
}

/** Last 7 days of one job's own runs, newest first — backs the Scheduled
 *  Jobs drawer's history table (same shape as getStorageBackupHistory,
 *  which is really just this call pinned to 'backupStorage'). */
export async function getCronHistory(jobName: string): Promise<CronRun[]> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/cron-log/${encodeURIComponent(jobName)}/history`, { headers: authHeaders() })
  );
  return data.data;
}

/** Runs a job right now instead of waiting for its tier's next tick. Rejects
 *  with 409 while the job is parked on 'off'. Returns the finished run. */
export async function runJobNow(jobName: string): Promise<CronRun | null> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/jobs/${encodeURIComponent(jobName)}/run`, {
      method: 'POST',
      headers: authHeaders(),
    })
  );
  return data.data;
}

export async function updateJobTier(jobName: string, cronTier: CronTier): Promise<ScheduledJob> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/jobs/${encodeURIComponent(jobName)}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ cron_tier: cronTier }),
    })
  );
  return data.data;
}

// --- Storage Backup tab: worker/storageBackup.ts's R2 mirror of Supabase
// Storage object bytes (migration 105). ------------------------------------

export type BackupBucket = 'record-docs' | 'rep-docs' | 'item-images';

export interface BucketBackupStatus {
  bucket: BackupBucket;
  total: number;
  backedUp: number;
  pending: number;
}

export interface StorageBackupState {
  buckets: BucketBackupStatus[];
  /** True while the job sits on the 'off' tier — no nightly ticks, and a run
   *  in progress stops at its next batch boundary. */
  paused: boolean;
  tier: CronTier | null;
}

export interface RestoreBatchResult {
  restored: number;
  failed: number;
  cursor: string | null;
}

export async function getStorageBackupStatus(): Promise<StorageBackupState> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings/storage-backup`, { headers: authHeaders() }));
  return data.data;
}

/** Last 7 days of backupStorage runs, newest first — reuses CronRun's shape. */
export async function getStorageBackupHistory(): Promise<CronRun[]> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings/storage-backup/history`, { headers: authHeaders() }));
  return data.data;
}

/** Runs one backup batch (up to 300 objects per bucket) right now instead of
 *  waiting for the next scheduled tick. Returns the refreshed status. Rejects
 *  with 409 while the backup is stopped. */
export async function runStorageBackupNow(): Promise<StorageBackupState> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/storage-backup/run`, { method: 'POST', headers: authHeaders() })
  );
  return data.data;
}

/** Stops or restarts the backup job: stopping skips every future scheduled
 *  tick AND cancels a run already in progress (it bails at its next batch
 *  boundary); restarting puts it back on the nightly schedule. */
export async function setStorageBackupPaused(paused: boolean): Promise<StorageBackupState> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/storage-backup/pause`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ paused }),
    })
  );
  return data.data;
}

export async function restoreStorageObject(bucket: BackupBucket, path: string): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/settings/storage-backup/restore`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ bucket, path }),
    })
  );
}

/** One cursor-paged batch of a whole-bucket restore — call again with the
 *  returned cursor until it comes back null. */
export async function restoreStorageBucketBatch(bucket: BackupBucket, cursor: string | null): Promise<RestoreBatchResult> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/storage-backup/restore-bucket`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ bucket, cursor }),
    })
  );
  return data.data;
}
