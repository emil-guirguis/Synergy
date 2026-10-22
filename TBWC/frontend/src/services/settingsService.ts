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

// --- Storage Backup tab: worker/storageBackup.ts's mirror of Supabase
// Storage object bytes into a second bucket in this same project
// (migration 105/109). --------------------------------------------------

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
  /** What the batch just run actually did — only present on the response to
   *  runStorageBackupNow(), never on a plain status GET. undefined means the
   *  run threw (runJob swallows job errors; the reason lands in the history
   *  table instead). */
  detail?: StorageBackupRunDetail;
}

/** worker/storageBackup.ts's StorageBackupRunDetail. `stopped` means the run
 *  bailed on its own time budget or the pause switch with work still pending —
 *  not a failure. */
export interface StorageBackupRunDetail {
  copied: number;
  failed: number;
  stopped: boolean;
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

/** Runs ONE backup batch right now instead of waiting for the next scheduled
 *  tick, and returns the refreshed status plus that batch's own `detail`.
 *
 *  One call can't clear a large backlog: Cloudflare caps a Worker invocation
 *  at 1000 subrequests and every object costs one Supabase copy call, so
 *  ~900-1000 objects is the hard ceiling per call no matter the time budget.
 *  To back up everything in one action, call this repeatedly while
 *  `detail.copied > 0` — that loop is what StorageBackupPanel's "Back up now"
 *  does. Rejects with 409 while the backup is stopped. */
export async function runStorageBackupNow(): Promise<StorageBackupState> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/storage-backup/run`, { method: 'POST', headers: authHeaders() })
  );
  return data.data;
}

export interface FullBackupBatch {
  copied: number;
  failed: number;
  /** Every live object across all buckets — the progress denominator. */
  total: number;
  /** Pass back as `cursor` to continue; null means finished. */
  cursor: string | null;
}

/** One page of a FULL backup — re-copies every file, already mirrored or not.
 *  Call repeatedly with the returned cursor until it's null; that loop is what
 *  the panel's "Back up now" runs, so a manual backup always backs everything
 *  up rather than reporting that nothing changed. */
export async function runFullStorageBackup(
  cursor: string | null
): Promise<StorageBackupState & { full: FullBackupBatch | null }> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/storage-backup/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ full: true, cursor }),
    })
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

// --- Backup tab: worker/backupExport.ts. Manual download-to-disk for the
// database and for storage (File System Access API, browser-driven), plus a
// read-only view of Supabase's own managed Postgres backups. Independent of
// the Storage Backup section above, which keeps mirroring to Supabase on its
// own schedule. ------------------------------------------------------------

function authHeadersNoContentType(): Record<string, string> {
  const token = tokenStorage.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface DbDumpProgress {
  /** Count of tableOrder — from the dump's own manifest line, so this only
   *  appears once the first chunk arrives. */
  totalTables?: number;
  tableIndex: number;
  table: string;
}

/** Reads the NDJSON stream's `{"table":"name"}` header lines (streamDatabaseDump's
 *  own per-table markers) without parsing every row — a plain prefix/suffix
 *  check, since that's the exact literal shape it writes. Consumes `stream`
 *  (call on a tee()'d branch, never the one also being written to disk). */
async function scanNdjsonProgress(stream: ReadableStream<Uint8Array>, onProgress: (p: DbDumpProgress) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let totalTables: number | undefined;
  let tableIndex = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (totalTables === undefined && line.startsWith('{"exportedAt"')) {
          try {
            totalTables = (JSON.parse(line).tableOrder ?? []).length;
          } catch { /* manifest line didn't parse — progress just won't show a total */ }
        } else if (line.startsWith('{"table":"') && line.endsWith('"}')) {
          tableIndex++;
          onProgress({ totalTables, tableIndex, table: line.slice('{"table":"'.length, -2) });
        }
      }
    }
  } catch {
    // Scanning is progress-only — a read error here shouldn't fail the
    // actual download, which is happening on the other tee()'d branch.
  }
}

/** Streams the full database dump and saves it wherever the user picks.
 *  showSaveFilePicker (Chromium) pipes the response straight to disk — an
 *  external drive included — without buffering it in page memory first;
 *  other browsers fall back to the classic blob+<a download> trick, which
 *  always lands in the default downloads location instead. Either way the
 *  body is tee()'d so `onProgress` can watch the same bytes going by for the
 *  current table name, without a second request. */
export async function downloadDatabaseBackup(onProgress?: (p: DbDumpProgress) => void): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/settings/backup/database`, { headers: authHeadersNoContentType() });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const filename = `tbwc-db-${new Date().toISOString().slice(0, 10)}.ndjson`;
  // Only tee when something will actually read the second branch — an
  // un-consumed tee() branch buffers the whole body in memory forever.
  const [toDest, toScan] = onProgress && res.body ? res.body.tee() : [res.body, null];
  const scanPromise = toScan && onProgress ? scanNdjsonProgress(toScan, onProgress) : Promise.resolve();

  const picker = (window as any).showSaveFilePicker;
  if (typeof picker === 'function' && toDest) {
    const handle = await picker({ suggestedName: filename });
    const writable = await handle.createWritable();
    await Promise.all([toDest.pipeTo(writable), scanPromise]);
    return;
  }
  const blob = await new Response(toDest ?? res.body).blob();
  await scanPromise;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ManagedBackupsResult {
  configured: boolean;
  pitrEnabled?: boolean;
  backups?: unknown[];
  error?: string;
}

export async function getManagedBackups(): Promise<ManagedBackupsResult> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings/backup/managed`, { headers: authHeaders() }));
  return data.data;
}

export interface LiveStorageObject {
  name: string;
  size: number | null;
}

export async function listLiveStorageObjects(
  bucket: BackupBucket,
  cursor: string | null
): Promise<{ objects: LiveStorageObject[]; cursor: string | null }> {
  const qs = new URLSearchParams({ bucket, ...(cursor ? { cursor } : {}) });
  const data = await parse(await fetch(`${API_BASE_URL}/settings/backup/storage/list?${qs}`, { headers: authHeaders() }));
  return data.data;
}

export async function fetchLiveStorageObjectBytes(bucket: BackupBucket, path: string): Promise<ArrayBuffer> {
  const qs = new URLSearchParams({ bucket, path });
  const res = await fetch(`${API_BASE_URL}/settings/backup/storage/object?${qs}`, { headers: authHeadersNoContentType() });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.arrayBuffer();
}

export async function restoreLiveStorageObjectBytes(bucket: BackupBucket, path: string, bytes: ArrayBuffer): Promise<void> {
  const qs = new URLSearchParams({ bucket, path });
  const res = await fetch(`${API_BASE_URL}/settings/backup/storage/object?${qs}`, {
    method: 'POST',
    headers: { ...authHeadersNoContentType(), 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}: ${res.statusText}`);
  }
}

export async function logBackupRun(
  jobName: 'exportStorage' | 'restoreStorage',
  status: 'ok' | 'error',
  detail?: Record<string, unknown> | null,
  durationMs?: number | null,
  error?: string | null
): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/settings/backup/log`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ job_name: jobName, status, detail, duration_ms: durationMs, error }),
    })
  );
}

/** Last 7 days across all three Backup-tab jobs (exportDatabase, exportStorage,
 *  restoreStorage), newest first — same CronRun shape as the rest of Settings. */
export async function getBackupHistory(): Promise<CronRun[]> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings/backup/history`, { headers: authHeaders() }));
  return data.data;
}
