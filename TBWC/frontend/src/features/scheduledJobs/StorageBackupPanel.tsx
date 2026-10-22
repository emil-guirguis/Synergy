/**
 * Settings > Backup. Two sub-tabs:
 *
 *  - Supabase: everything that happens on Supabase's own side. The nightly
 *    worker/storageBackup.ts mirror of record-docs/rep-docs/item-images into
 *    a second bucket (migrations 105/106/109) — per-bucket progress, a
 *    manual "back up now", a stop/resume switch, and restore (one file or a
 *    whole bucket) from that mirror — plus a read-only list of Supabase's own
 *    managed Postgres backups (worker/backupExport.ts's Management API call).
 *    The mirror copying happens in the Worker on a Cron Trigger regardless of
 *    whether this page is open; only whole-bucket restore genuinely needs it
 *    open (its loop lives in confirmRestoreBucket below).
 *
 *  - Manual: on-demand copies the admin saves themselves, to disk — a full
 *    database download (NDJSON) and a storage export/restore driven by the
 *    browser's File System Access API (picks a folder, loops pages of
 *    objects). Independent of the Supabase mirror; its own 7-day history.
 *
 * Both tabs' histories ride cron_run_log, whose own retention
 * (pruneCronRunLog, daily) caps every job_name's rows at 7 days — see
 * migration 106.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, LinearProgress, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Tab, Tabs, TextField, Typography,
} from '@mui/material';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import RestoreIcon from '@mui/icons-material/Restore';
import StopIcon from '@mui/icons-material/Stop';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';
import FolderIcon from '@mui/icons-material/Folder';
import UploadIcon from '@mui/icons-material/Upload';
import { formatDateTime } from '@meterit/framework-frontend/utils';
import {
  getStorageBackupStatus, getStorageBackupHistory, runFullStorageBackup,
  restoreStorageObject, restoreStorageBucketBatch, setStorageBackupPaused,
  downloadDatabaseBackup, getManagedBackups, listLiveStorageObjects,
  fetchLiveStorageObjectBytes, restoreLiveStorageObjectBytes, logBackupRun,
  getBackupHistory,
  type StorageBackupState, type BackupBucket, type CronRun, type ManagedBackupsResult, type DbDumpProgress,
} from '../../services/settingsService';

const EXPORT_BUCKETS: BackupBucket[] = ['record-docs', 'rep-docs', 'item-images'];

/** Creates (or opens) each path segment but the last as a directory, under `root`. */
async function dirFor(root: any, parts: string[]): Promise<any> {
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

/** dirFor, memoised on the directory path, for the concurrent export/restore
 *  loops below. Two purposes: it skips re-walking the same folder chain for
 *  every file in it, and — because the cached value is the in-flight promise,
 *  not the resolved handle — it means two files in the same new folder can't
 *  race each other into two concurrent `getDirectoryHandle(..., {create:true})`
 *  calls for the same name. One cache per export run; handles are only valid
 *  for the `root` the user picked that time. */
function dirForCached(root: any, parts: string[], cache: Map<string, Promise<any>>): Promise<any> {
  const key = parts.join('/');
  let pending = cache.get(key);
  if (!pending) {
    pending = dirFor(root, parts);
    cache.set(key, pending);
  }
  return pending;
}

/** Files handled at once by the to-disk export/restore loops. Unlike the
 *  server-side mirror's CONCURRENCY of 25 (storageBackup.ts — small API calls,
 *  no bytes moving, pure round-trip latency), every file here really does
 *  travel Supabase -> Worker -> browser -> disk, so this is bounded by
 *  bandwidth and disk rather than latency, and a high number just thrashes.
 *  8 keeps the pipe full while the previous writes land. It is still the
 *  difference between a strictly serial loop and finishing a ~12.8k-file,
 *  ~16GB export in a sitting. */
const DISK_CONCURRENCY = 8;

/** Enough consecutive-ish per-file failures to call the whole run broken
 *  rather than carrying on. A handful of failures is a transient 500 on one
 *  object and shouldn't abandon an hour-long export; hundreds means something
 *  systemic (folder permission revoked, disk full, session expired), and
 *  grinding through thousands of doomed files to report it is worse than
 *  stopping. */
const DISK_FAILURE_LIMIT = 100;

/** Splits an async iterable into fixed-size arrays, so the restore loop can
 *  walk a directory tree lazily but still hand whole chunks to Promise.all. */
async function* inChunks<T>(it: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let chunk: T[] = [];
  for await (const item of it) {
    chunk.push(item);
    if (chunk.length >= size) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length) yield chunk;
}

/** Walks a directory handle recursively, yielding [relativePath, fileHandle]
 *  for every file — used to replay a previously exported folder back into
 *  live storage, one object per file found. */
async function* walkFiles(dir: any, prefix: string[] = []): AsyncGenerator<[string, any]> {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      yield* walkFiles(handle, [...prefix, name]);
    } else {
      yield [[...prefix, name].join('/'), handle];
    }
  }
}

const BUCKET_LABELS: Record<BackupBucket, string> = {
  'record-docs': 'Order/quote/invoice documents',
  'rep-docs': 'Rep resources',
  'item-images': 'Inventory item images',
};

// Settings > System Config's own date/time format + timezone — same formatter
// every grid column in the app already uses (framework/frontend's renderHelpers).
function fmtTime(iso: string): string {
  return formatDateTime(iso);
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Coarse "how long left" for a run in progress, from the rate it has
 *  actually achieved so far rather than any assumed throughput — the two
 *  differ by orders of magnitude between the server-side mirror (no bytes
 *  move) and the to-disk export (every byte does). Returns '' until there's
 *  enough done to extrapolate from; a wrong ETA is worse than none. */
function etaText(done: number, total: number, elapsedMs: number): string {
  const remaining = total - done;
  if (done < 20 || remaining <= 0 || elapsedMs < 3000) return '';
  const perMs = done / elapsedMs;
  if (perMs <= 0) return '';
  const leftMs = remaining / perMs;
  if (leftMs < 45_000) return 'under a minute left';
  const mins = Math.round(leftMs / 60_000);
  if (mins < 60) return `~${mins} min left`;
  const hours = Math.floor(mins / 60);
  return `~${hours}h ${mins % 60}m left`;
}

/** Milliseconds since `active` last went true, ticking once a second; 0 while
 *  inactive. Drives the elapsed/ETA readouts — the progress counts alone
 *  can't tell you whether a run is moving or wedged. */
function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return elapsed;
}

function HistoryStatusChip({ status }: { status: CronRun['status'] }) {
  if (status === 'running') return <Chip size="small" label="running" color="warning" variant="outlined" />;
  if (status === 'error') return <Chip size="small" label="error" color="error" />;
  return <Chip size="small" label="ok" color="success" variant="outlined" />;
}

// detail jsonb (migration 108) on a backupStorage row is {copied, failed,
// stopped} — see storageBackup.ts's StorageBackupRunDetail.
function fmtDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return '—';
  const { copied, failed, stopped } = detail as { copied?: number; failed?: number; stopped?: boolean };
  return `${copied ?? 0} copied${failed ? `, ${failed} failed` : ''}${stopped ? ' (stopped early)' : ''}`;
}

/** What the last backup run did, shown in the card itself so the answer to
 *  "did that button do anything?" is always next to the button: whether it
 *  ran, whether it finished or was stopped, how long it took, and how many
 *  files it copied. */
interface LastRun {
  outcome: 'complete' | 'uptodate' | 'stopped' | 'failed';
  copied: number;
  failed: number;
  /** How many server batches the run took; 1 for a run read back from history. */
  batches: number;
  durationMs: number | null;
  /** ISO timestamp the run ended. */
  at: string | null;
}

/** Builds the LastRun line from a cron_run_log row, so the card says what the
 *  last run did even on a fresh page load — including the nightly ones that
 *  happened while nobody was looking. */
function lastRunFromHistory(run: CronRun | undefined): LastRun | null {
  if (!run) return null;
  const d = (run.detail ?? {}) as { copied?: number; failed?: number; stopped?: boolean };
  const copied = d.copied ?? 0;
  const outcome: LastRun['outcome'] =
    run.status === 'error' ? 'failed' : d.stopped ? 'stopped' : copied > 0 ? 'complete' : 'uptodate';
  return {
    outcome,
    copied,
    failed: d.failed ?? 0,
    batches: 1,
    durationMs: run.duration_ms,
    at: run.finished_at ?? run.started_at,
  };
}

const LAST_RUN_SEVERITY: Record<LastRun['outcome'], 'success' | 'info' | 'warning' | 'error'> = {
  complete: 'success',
  uptodate: 'info',
  stopped: 'warning',
  failed: 'error',
};

function lastRunHeadline(r: LastRun): string {
  if (r.outcome === 'failed') return 'Last run failed';
  if (r.outcome === 'stopped') return 'Last run was stopped';
  // Only a scheduled run can land here: it copies just what's new, so zero
  // copied means nothing was added since the run before it. "Back up now"
  // always re-copies everything, so a manual run is never 'uptodate'.
  if (r.outcome === 'uptodate') return 'Last scheduled run: no new files to copy';
  return 'Last run finished';
}

const JOB_LABELS: Record<string, string> = {
  exportDatabase: 'Database download',
  exportStorage: 'Storage export',
  restoreStorage: 'Storage restore',
};

// detail jsonb shape differs by job: exportDatabase writes {tables, rows}
// (streamDatabaseDump), exportStorage/restoreStorage write {written, failed}
// and export additionally {skipped} — the browser-driven folder loops report
// their own counts, where skipped means "already on disk at the right size",
// i.e. a resumed run.
function fmtDiskDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return '—';
  const d = detail as { tables?: number; rows?: number; written?: number; skipped?: number; failed?: number };
  if (typeof d.written === 'number') {
    const parts = [`${d.written.toLocaleString()} files`];
    if (d.skipped) parts.push(`${d.skipped.toLocaleString()} skipped`);
    if (d.failed) parts.push(`${d.failed.toLocaleString()} failed`);
    return parts.join(', ');
  }
  if (typeof d.rows === 'number') return `${d.tables ?? 0} tables, ${d.rows.toLocaleString()} rows`;
  return '—';
}

// Supabase's Management API backup-listing shape isn't pinned down here —
// render whatever common fields are present rather than assume one exact
// response shape, falling back to the raw object for anything unrecognized.
function summarizeManagedBackup(b: unknown): string {
  if (!b || typeof b !== 'object') return String(b);
  const r = b as Record<string, unknown>;
  const when = r.inserted_at ?? r.created_at ?? r.started_at ?? r.date;
  const status = r.status ?? (r.isPhysicalBackup ? 'physical' : undefined);
  if (when || status) return [typeof when === 'string' ? fmtTime(when) : when, status].filter(Boolean).join(' · ');
  return JSON.stringify(b);
}

export default function StorageBackupPanel() {
  const [state, setState] = useState<StorageBackupState | null>(null);
  const [history, setHistory] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  // Files copied so far by the multi-batch run in progress — drives the "Back
  // up now" progress readout, which a plain status refresh can't give on its
  // own (that shows the standing totals, not this run's contribution).
  const [runCopied, setRunCopied] = useState(0);
  const [runBatches, setRunBatches] = useState(0);
  // Total files this run will copy — reported by the server, since a full
  // backup's denominator is every object, not just the pending ones.
  const [runTotal, setRunTotal] = useState(0);
  // Outcome of the last run, kept on screen inside the card rather than only
  // in the transient banner at the top of the panel. The banner is ~1000px
  // above the button (past the history table, inside an inner scroll
  // container), so after scrolling down to press "Back up now" its result was
  // never in view — the run looked like it did nothing even when it worked.
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  // A ref, not state, for the same reason as bulkCancelledRef below: the run
  // loop is an already-executing async function and would never see a later
  // setState.
  const runCancelledRef = useRef(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [restoreBucket, setRestoreBucket] = useState<BackupBucket | null>(null);
  const [restorePath, setRestorePath] = useState('');
  const [restoring, setRestoring] = useState(false);

  const [bulkRestoreBucket, setBulkRestoreBucket] = useState<BackupBucket | null>(null);
  const [bulkRestoring, setBulkRestoring] = useState(false);
  const [bulkRestored, setBulkRestored] = useState(0);
  // A ref, not state: the restore loop below reads this on every iteration of
  // an already-running async function, which closes over state at call time
  // and would never see a later setState — only a mutable ref is visible to it.
  const bulkCancelledRef = useRef(false);

  const [dbDownloading, setDbDownloading] = useState(false);
  const [dbProgress, setDbProgress] = useState<DbDumpProgress | null>(null);
  const [managed, setManaged] = useState<ManagedBackupsResult | null>(null);
  const [diskHistory, setDiskHistory] = useState<CronRun[]>([]);
  const [exportingDisk, setExportingDisk] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportCurrentFile, setExportCurrentFile] = useState('');
  // Shared by the export and restore loops — only one of the two can run at a
  // time (each button is disabled while either is going), so one flag covers
  // both. A ref for the same reason as the others here: the loop reading it is
  // already executing and would never see a setState.
  const diskCancelledRef = useRef(false);
  // Mirrors the refs purely so the Stop buttons can grey out the instant
  // they're pressed. The refs stay the loops' source of truth — a ref change
  // doesn't re-render, so without this a Stop button stays live-looking until
  // the next progress tick.
  const [stopRequested, setStopRequested] = useState(false);
  const [restoringDisk, setRestoringDisk] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [restoreCurrentFile, setRestoreCurrentFile] = useState('');
  const [confirmRestoreDisk, setConfirmRestoreDisk] = useState(false);

  const [tab, setTab] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, h, m, dh] = await Promise.all([
        getStorageBackupStatus(), getStorageBackupHistory(), getManagedBackups(), getBackupHistory(),
      ]);
      setState(s);
      setHistory(h);
      setManaged(m);
      setDiskHistory(dh);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load backup status');
    } finally {
      setLoading(false);
    }
  }, []);

  const downloadDb = useCallback(async () => {
    setDbDownloading(true);
    setDbProgress(null);
    setError(null);
    setMessage(null);
    try {
      await downloadDatabaseBackup(setDbProgress);
      setMessage('Database backup downloaded.');
      setDiskHistory(await getBackupHistory());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Database download failed');
    } finally {
      setDbDownloading(false);
    }
  }, []);

  const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

  // Exports one object to disk, or reports that it didn't need exporting.
  // The size check is what makes a to-disk export resumable: unlike the
  // Supabase mirror, which has public.storage_backup_object as a ledger, this
  // side's only record of what it already copied is the folder itself. Without
  // the check, an export that died (or was stopped) at file 9,000 of 12,800
  // re-downloaded all 12,800 bytes-first on the next attempt. Matching size is
  // the strongest signal available cheaply — reading every file back to
  // compare contents would cost the same bandwidth the skip is there to save.
  const exportOneToDisk = useCallback(
    async (
      root: any,
      bucket: BackupBucket,
      obj: { name: string; size: number | null },
      dirCache: Map<string, Promise<any>>
    ): Promise<'written' | 'skipped'> => {
      const parts = obj.name.split('/');
      const fileName = parts[parts.length - 1];
      const dir = await dirForCached(root, [bucket, ...parts.slice(0, -1)], dirCache);
      if (obj.size != null) {
        try {
          const existing = await (await dir.getFileHandle(fileName)).getFile();
          if (existing.size === obj.size) return 'skipped';
        } catch {
          // Not on disk yet (or unreadable) — fall through and fetch it.
        }
      }
      const bytes = await fetchLiveStorageObjectBytes(bucket, obj.name);
      const fileHandle = await dir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return 'written';
    },
    []
  );

  const exportStorageToDisk = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      setError("This browser can't save a folder of files — use Chrome or Edge.");
      return;
    }
    setExportingDisk(true);
    setExportProgress(0);
    setExportCurrentFile('');
    setError(null);
    setMessage(null);
    diskCancelledRef.current = false;
    setStopRequested(false);
    const startedAt = Date.now();
    const dirCache = new Map<string, Promise<any>>();
    let written = 0;
    let skipped = 0;
    let failed = 0;
    let lastFailure: string | null = null;
    let cancelled = false;
    try {
      const root = await (window as any).showDirectoryPicker();
      // Labelled so the stop flag and the failure limit can break out of the
      // whole sweep, not just the bucket being walked.
      sweep: for (const bucket of EXPORT_BUCKETS) {
        let cursor: string | null = null;
        do {
          const page = await listLiveStorageObjects(bucket, cursor);
          for (let i = 0; i < page.objects.length; i += DISK_CONCURRENCY) {
            if (diskCancelledRef.current) { cancelled = true; break sweep; }
            const chunk = page.objects.slice(i, i + DISK_CONCURRENCY);
            setExportCurrentFile(`${bucket}/${chunk[0].name}`);
            // A single file failing (one transient 500, one unreadable object)
            // is counted and stepped over rather than abandoning the run —
            // same decision the server-side mirror makes per object. Hundreds
            // of them is systemic, and DISK_FAILURE_LIMIT below stops.
            const results = await Promise.all(
              chunk.map(async (obj) => {
                try {
                  return await exportOneToDisk(root, bucket, obj, dirCache);
                } catch (e) {
                  lastFailure = `${bucket}/${obj.name}: ${e instanceof Error ? e.message : String(e)}`;
                  console.error('[backup] export failed for', `${bucket}/${obj.name}`, e);
                  return 'failed' as const;
                }
              })
            );
            for (const r of results) {
              if (r === 'written') written++;
              else if (r === 'skipped') skipped++;
              else failed++;
            }
            setExportProgress(written + skipped);
            if (failed >= DISK_FAILURE_LIMIT) {
              throw new Error(
                `Export stopped after ${failed} files failed — last error: ${lastFailure ?? 'unknown'}`
              );
            }
          }
          cursor = page.cursor;
        } while (cursor);
      }
      const detail = { written, skipped, failed };
      await logBackupRun('exportStorage', failed > 0 ? 'error' : 'ok', detail, Date.now() - startedAt,
        failed > 0 ? `${failed} files failed — last: ${lastFailure}` : null);
      const skippedNote = skipped > 0 ? `, ${skipped.toLocaleString()} already present and skipped` : '';
      const failedNote = failed > 0 ? `, ${failed.toLocaleString()} failed` : '';
      setMessage(
        cancelled
          ? `Export stopped — ${written.toLocaleString()} files written${skippedNote}${failedNote}. Running it again on the same folder resumes where this left off.`
          : `Exported ${written.toLocaleString()} files to the chosen folder${skippedNote}${failedNote}.`
      );
      setDiskHistory(await getBackupHistory());
    } catch (e) {
      if (!isAbort(e)) {
        const msg = e instanceof Error ? e.message : 'Export failed';
        setError(msg);
        await logBackupRun('exportStorage', 'error', { written, skipped, failed }, Date.now() - startedAt, msg).catch(() => {});
        setDiskHistory(await getBackupHistory().catch(() => diskHistory));
      }
    } finally {
      setExportingDisk(false);
    }
  }, [diskHistory, exportOneToDisk]);

  const restoreStorageFromDisk = useCallback(async () => {
    setConfirmRestoreDisk(false);
    if (!('showDirectoryPicker' in window)) {
      setError("This browser can't read a folder of files — use Chrome or Edge.");
      return;
    }
    setRestoringDisk(true);
    setRestoreProgress(0);
    setRestoreCurrentFile('');
    setError(null);
    setMessage(null);
    diskCancelledRef.current = false;
    setStopRequested(false);
    const startedAt = Date.now();
    let written = 0;
    let failed = 0;
    let lastFailure: string | null = null;
    let cancelled = false;
    try {
      const root = await (window as any).showDirectoryPicker();
      // Deliberately NO size-match skip here, unlike the export above. This
      // direction is authoritative — the point is to make live storage match
      // the folder — and a file that is the same size but different content is
      // exactly what someone restoring after a corruption is trying to
      // overwrite. Re-uploading something already identical is a harmless
      // no-op; skipping something subtly different is a silent failed restore.
      sweep: for (const bucket of EXPORT_BUCKETS) {
        let bucketDir;
        try {
          bucketDir = await root.getDirectoryHandle(bucket);
        } catch {
          continue; // chosen folder has no subfolder for this bucket — nothing to restore
        }
        for await (const chunk of inChunks(walkFiles(bucketDir), DISK_CONCURRENCY)) {
          if (diskCancelledRef.current) { cancelled = true; break sweep; }
          setRestoreCurrentFile(`${bucket}/${chunk[0][0]}`);
          const results = await Promise.all(
            chunk.map(async ([path, fileHandle]) => {
              try {
                const file = await fileHandle.getFile();
                await restoreLiveStorageObjectBytes(bucket, path, await file.arrayBuffer());
                return true;
              } catch (e) {
                lastFailure = `${bucket}/${path}: ${e instanceof Error ? e.message : String(e)}`;
                console.error('[backup] restore failed for', `${bucket}/${path}`, e);
                return false;
              }
            })
          );
          written += results.filter(Boolean).length;
          failed += results.length - results.filter(Boolean).length;
          setRestoreProgress(written);
          if (failed >= DISK_FAILURE_LIMIT) {
            throw new Error(`Restore stopped after ${failed} files failed — last error: ${lastFailure ?? 'unknown'}`);
          }
        }
      }
      await logBackupRun('restoreStorage', failed > 0 ? 'error' : 'ok', { written, failed }, Date.now() - startedAt,
        failed > 0 ? `${failed} files failed — last: ${lastFailure}` : null);
      const failedNote = failed > 0 ? `, ${failed.toLocaleString()} failed` : '';
      setMessage(
        cancelled
          ? `Restore stopped — ${written.toLocaleString()} files restored${failedNote}. Files not reached yet are untouched in live storage.`
          : `Restored ${written.toLocaleString()} files from the chosen folder${failedNote}.`
      );
      setDiskHistory(await getBackupHistory());
    } catch (e) {
      if (!isAbort(e)) {
        const msg = e instanceof Error ? e.message : 'Restore failed';
        setError(msg);
        await logBackupRun('restoreStorage', 'error', { written, failed }, Date.now() - startedAt, msg).catch(() => {});
        setDiskHistory(await getBackupHistory().catch(() => diskHistory));
      }
    } finally {
      setRestoringDisk(false);
    }
  }, [diskHistory]);

  useEffect(() => { load(); }, [load]);

  // "Back up now" is one click that runs to completion, but it can't be one
  // request: Cloudflare caps a Worker invocation at 1000 subrequests and every
  // object costs one Supabase copy call, so a single call clears ~900-1000
  // objects at most however long its budget is (see storageBackup.ts's
  // MAX_TICK_MILLIS, sized to land just under that cap). A full ~12.8k-object
  // sweep is therefore ~14 calls, driven from here in a loop rather than left
  // to a tick a day — measured end to end at ~15.6 objects/sec, so ~14 minutes
  // for everything.
  //
  // The loop stops when a batch copies nothing. That's the condition that
  // matters rather than "pending === 0": objects that fail every attempt
  // (unreadable source bytes, say) stay pending forever, and looping on
  // pending would spin on them until the tab closed. A batch that copied 0 but
  // failed > 0 has hit exactly that floor — report it and stop.
  //
  // Needs the tab open, like the bucket restore below. Closing it mid-run
  // loses nothing: every object's ledger row is written as it's copied, so the
  // next click (or the nightly tick) resumes from where this stopped.
  const runNow = useCallback(async () => {
    setRunning(true);
    setError(null);
    setMessage(null);
    runCancelledRef.current = false;
    setStopRequested(false);
    setRunCopied(0);
    setRunBatches(0);
    setRunTotal(0);
    setLastRun(null);
    let copiedTotal = 0;
    let failedTotal = 0;
    let batches = 0;
    const startedAt = Date.now();
    // Within a single batch the server marks each object backed-up as it goes
    // (not in one final transaction), so polling the cheap status query while a
    // batch is in flight makes the per-bucket bars creep up in near-real-time
    // instead of jumping once per batch. Separate lightweight GET — no effect
    // on the run's own speed.
    const poll = window.setInterval(() => {
      getStorageBackupStatus().then(setState).catch(() => {});
    }, 1500);
    try {
      let cursor: string | null = null;
      for (;;) {
        const next = await runFullStorageBackup(cursor);
        setState(next);
        batches++;
        // null `full` = the job threw; runJob swallows job errors, so the
        // reason is in the history table rather than this response. Stop
        // either way — retrying a throwing job in a tight loop is pointless.
        if (!next.full) break;
        copiedTotal += next.full.copied;
        failedTotal += next.full.failed;
        setRunCopied(copiedTotal);
        setRunBatches(batches);
        setRunTotal(next.full.total);
        cursor = next.full.cursor;
        if (cursor === null || runCancelledRef.current) break;
      }
      setLastRun({
        outcome: runCancelledRef.current ? 'stopped' : failedTotal > 0 ? 'failed' : 'complete',
        copied: copiedTotal,
        failed: failedTotal,
        batches,
        durationMs: Date.now() - startedAt,
        at: new Date().toISOString(),
      });
      const mins = (Date.now() - startedAt) / 60000;
      const took = mins >= 1 ? ` in ${mins.toFixed(1)} min` : '';
      if (runCancelledRef.current) {
        setMessage(
          `Stopped after ${copiedTotal.toLocaleString()} files${took}. Everything copied so far stays backed up — running again picks up where this left off.`
        );
      } else if (failedTotal > 0) {
        setMessage(
          `Copied ${copiedTotal.toLocaleString()} files${took}. ${failedTotal.toLocaleString()} could not be copied and are still pending — see the run history for the reason.`
        );
      } else {
        setMessage(
          `Backup complete — ${copiedTotal.toLocaleString()} files copied${took} over ${batches} ${batches === 1 ? 'batch' : 'batches'}.`
        );
      }
      setHistory(await getStorageBackupHistory());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backup run failed');
    } finally {
      window.clearInterval(poll);
      setRunning(false);
    }
  }, []);

  // Stopping is a server-side state change, not a client-side abort: the
  // backup runs in the Worker on a schedule, so "stop" has to be something a
  // later tick (or the tick running right now) can read — migration 107.
  const togglePause = useCallback(async (next: boolean) => {
    setTogglingPause(true);
    setError(null);
    setMessage(null);
    try {
      setState(await setStorageBackupPaused(next));
      setMessage(
        next
          ? 'Backup stopped. Scheduled runs are skipped, and a run in progress stops within a few dozen files.'
          : 'Backup resumed on the nightly schedule.'
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change backup state');
    } finally {
      setTogglingPause(false);
    }
  }, []);

  const confirmRestoreFile = useCallback(async () => {
    if (!restoreBucket || !restorePath.trim()) return;
    setRestoring(true);
    setError(null);
    setMessage(null);
    try {
      await restoreStorageObject(restoreBucket, restorePath.trim());
      setMessage(`Restored ${restoreBucket}/${restorePath.trim()} from backup.`);
      setRestoreBucket(null);
      setRestorePath('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setRestoring(false);
    }
  }, [restoreBucket, restorePath]);

  const confirmRestoreBucket = useCallback(async () => {
    if (!bulkRestoreBucket) return;
    setBulkRestoring(true);
    setBulkRestored(0);
    bulkCancelledRef.current = false;
    setError(null);
    let cursor: string | null = null;
    try {
      do {
        const result = await restoreStorageBucketBatch(bulkRestoreBucket, cursor);
        setBulkRestored((n) => n + result.restored);
        cursor = result.cursor;
      } while (cursor && !bulkCancelledRef.current);
      setMessage(`Restore of "${bulkRestoreBucket}" from backup complete.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bucket restore failed');
    } finally {
      setBulkRestoring(false);
      setBulkRestoreBucket(null);
    }
  }, [bulkRestoreBucket]);

  const paused = state?.paused ?? false;
  // Reuses the mirror's own per-bucket totals (same live storage.objects
  // count the Cloud tab shows) as the denominator for the export's progress
  // bar — no separate count-everything-first pass needed.
  const exportTotal = state ? state.buckets.reduce((n, b) => n + b.total, 0) : 0;
  const runElapsed = useElapsed(running);
  // This session's run if there's been one, otherwise whatever the newest
  // logged run did — so the card is never silent about the last backup.
  const lastRunShown = lastRun ?? lastRunFromHistory(history[0]);
  // A full backup's denominator is every object; until the first batch reports
  // it, fall back to the bucket totals already on screen.
  const runDenominator = runTotal || exportTotal;
  const diskElapsed = useElapsed(exportingDisk || restoringDisk);

  return (
    <Box data-testid="storage-backup-panel">
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {message && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMessage(null)}>{message}</Alert>}

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Cloud" />
        <Tab label="Manual" />
      </Tabs>

      {tab === 0 && (
        <>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="stretch">
            <Card variant="outlined" sx={{ flex: 1, minWidth: 0, width: '100%' }}>
              <CardContent sx={{ height: '100%' }}>
                <Typography variant="h6" sx={{ mb: 1 }}>Database backup history</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Daily Postgres backups the cloud provider keeps on its own — read-only here, nothing copied.
                </Typography>
                {!managed ? (
                  <Typography variant="body2" color="text.secondary">Loading…</Typography>
                ) : !managed.configured ? (
                  <Alert severity="info">
                    Not set up yet — create a personal access token at supabase.com/dashboard/account/tokens
                    and set it as the <code>SUPABASE_ACCESS_TOKEN</code> secret to see them here.
                  </Alert>
                ) : managed.error ? (
                  <Alert severity="error">{managed.error}</Alert>
                ) : !managed.backups || managed.backups.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">No managed backups reported yet.</Typography>
                ) : (
                  <Stack spacing={0.5}>
                    {managed.pitrEnabled && (
                      <Typography variant="caption" color="text.secondary">Point-in-time recovery is enabled.</Typography>
                    )}
                    {managed.backups.map((b, i) => (
                      <Typography key={i} variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {summarizeManagedBackup(b)}
                      </Typography>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>

            <Card variant="outlined" sx={{ flex: 1, minWidth: 0, width: '100%' }}>
              <CardContent sx={{ height: '100%' }}>
                <Typography variant="h6" sx={{ mb: 1 }}>Document backup history</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Last 7 days of runs (scheduled and manual). Older rows are pruned automatically.
                </Typography>
                {history.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">No runs in the last 7 days.</Typography>
                ) : (
                  <TableContainer sx={{ overflowX: 'auto' }}>
                    <Table size="small" data-testid="storage-backup-history-table">
                      <TableHead>
                        <TableRow>
                          <TableCell>Started</TableCell>
                          <TableCell>Finished</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell align="right">Duration</TableCell>
                          <TableCell>Copied</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {history.map((run) => (
                          <TableRow key={run.cron_run_log_id}>
                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtTime(run.started_at)}</TableCell>
                            {/* cron_run_log has always recorded this; the table
                                just never showed it, so a finished run read as
                                open-ended. Null only while a run is actually in
                                flight (or was killed before runJob's finish
                                write — healStaleRunningRows cleans those up). */}
                            <TableCell sx={{ whiteSpace: 'nowrap' }}>
                              {run.finished_at ? fmtTime(run.finished_at) : <em>still running</em>}
                            </TableCell>
                            <TableCell>
                              <Stack direction="row" spacing={1} alignItems="center">
                                <HistoryStatusChip status={run.status} />
                                {run.status === 'error' && run.error && (
                                  <Typography variant="caption" color="error.main" noWrap sx={{ maxWidth: 400 }}>
                                    {run.error}
                                  </Typography>
                                )}
                              </Stack>
                            </TableCell>
                            <TableCell align="right">{fmtDuration(run.duration_ms)}</TableCell>
                            <TableCell>
                              <Typography variant="caption" color="text.secondary">{fmtDetail(run.detail)}</Typography>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </CardContent>
            </Card>
          </Stack>

          <Card variant="outlined" sx={{ mt: 2 }}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6">Document backup</Typography>
                    {paused && (
                      <Chip size="small" label="Stopped" color="warning" data-testid="storage-backup-paused-chip" />
                    )}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    Mirrors file bytes into a second bucket. The cloud provider's own backups cover the database only.
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    Runs on the server on a schedule (nightly, ~2am Pacific) — this page does not need to be open.
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    "Back up now" re-copies every file, not just new ones — keep this page open while it
                    runs (around 15 minutes for all {exportTotal.toLocaleString()}). Stopping it is safe:
                    everything already copied stays backed up.
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button
                    variant="outlined"
                    size="small"
                    color={paused ? 'success' : 'warning'}
                    startIcon={paused ? <PlayArrowIcon /> : <StopIcon />}
                    onClick={() => togglePause(!paused)}
                    disabled={togglingPause || loading || !state}
                    data-testid="storage-backup-pause-toggle"
                  >
                    {togglingPause ? 'Saving…' : paused ? 'Resume backup' : 'Stop backup'}
                  </Button>
                  {running ? (
                    <Button
                      variant="outlined"
                      size="small"
                      color="warning"
                      startIcon={<StopIcon />}
                      onClick={() => { runCancelledRef.current = true; setStopRequested(true); }}
                      disabled={stopRequested}
                      data-testid="storage-backup-stop-run"
                    >
                      Stop after this batch
                    </Button>
                  ) : (
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<CloudSyncIcon />}
                      onClick={runNow}
                      disabled={loading || paused}
                      data-testid="storage-backup-run-now"
                    >
                      Back up now
                    </Button>
                  )}
                </Stack>
              </Stack>

              {paused && (
                <Alert severity="warning" sx={{ mb: 2 }} data-testid="storage-backup-paused-alert">
                  Backup is stopped — no scheduled runs, and a run already in progress stops within a few
                  dozen files. Everything already mirrored stays backed up; resuming picks up where it left off.
                </Alert>
              )}

              {loading && !running && <LinearProgress sx={{ mb: 2 }} />}

              {/* The answer to "did that do anything?", kept next to the
                  button. While running it proves the run is alive even when no
                  file has been copied yet; afterwards it stays put with the
                  outcome, duration and total, instead of vanishing with the
                  banner at the top of the panel. Falls back to the newest
                  cron_run_log row, so a fresh page load still says what the
                  last run (including an overnight one) did. */}
              {running ? (
                <Alert severity="info" icon={false} sx={{ mb: 2 }} data-testid="storage-backup-run-status">
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <strong>{stopRequested ? 'Stopping after this batch…' : 'Running…'}</strong>
                    <span>{runCopied.toLocaleString()} files copied</span>
                    <span>·</span>
                    <span>{runBatches.toLocaleString()} {runBatches === 1 ? 'batch' : 'batches'}</span>
                    <span>·</span>
                    <span>{fmtDuration(runElapsed)} elapsed</span>
                  </Stack>
                </Alert>
              ) : lastRunShown ? (
                <Alert
                  severity={LAST_RUN_SEVERITY[lastRunShown.outcome]}
                  icon={false}
                  sx={{ mb: 2 }}
                  data-testid="storage-backup-run-status"
                >
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <strong>{lastRunHeadline(lastRunShown)}</strong>
                    <span>·</span>
                    <span>{lastRunShown.copied.toLocaleString()} files copied</span>
                    {lastRunShown.failed > 0 && (
                      <>
                        <span>·</span>
                        <span>{lastRunShown.failed.toLocaleString()} failed</span>
                      </>
                    )}
                    <span>·</span>
                    <span>took {fmtDuration(lastRunShown.durationMs)}</span>
                    {lastRunShown.at && (
                      <>
                        <span>·</span>
                        <span>{fmtTime(lastRunShown.at)}</span>
                      </>
                    )}
                  </Stack>
                </Alert>
              ) : null}

              {/* Overall progress for the multi-batch run — the per-bucket bars
                  below still show each bucket, but a run spanning all three
                  needs one number to watch. Determinate against this run's own
                  workload (what was pending when it started = copied so far +
                  what's left), so the bar fills to 100% as the run finishes
                  rather than tracking the all-time total. */}
              {running && (
                <Box sx={{ mb: 2 }} data-testid="storage-backup-running-progress">
                  <LinearProgress
                    variant={runDenominator > 0 ? 'determinate' : 'indeterminate'}
                    value={runDenominator > 0 ? Math.min(100, Math.round((runCopied / runDenominator) * 100)) : undefined}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {runCopied === 0
                      ? `Starting… · ${fmtDuration(runElapsed)} elapsed`
                      : [
                          `${runCopied.toLocaleString()} of ${runDenominator.toLocaleString()} files copied`,
                          `${fmtDuration(runElapsed)} elapsed`,
                          etaText(runCopied, runDenominator, runElapsed) || null,
                        ].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
              )}

              {state && (
                <Stack spacing={2}>
                  {state.buckets.map((s) => {
                    const pct = s.total === 0 ? 100 : Math.round((s.backedUp / s.total) * 100);
                    return (
                      <Box key={s.bucket}>
                        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                          <Typography variant="subtitle2">{BUCKET_LABELS[s.bucket] ?? s.bucket}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {s.backedUp.toLocaleString()} / {s.total.toLocaleString()} objects
                            {s.pending > 0 ? ` · ${s.pending.toLocaleString()} pending` : ''}
                          </Typography>
                        </Stack>
                        <LinearProgress variant="determinate" value={pct} sx={{ my: 0.5 }} />
                      </Box>
                    );
                  })}
                  <Button
                    size="small"
                    sx={{ alignSelf: 'flex-start' }}
                    startIcon={<RestoreIcon />}
                    onClick={() => setBulkRestoreBucket(state.buckets.find((s) => s.backedUp > 0)?.bucket ?? null)}
                    disabled={bulkRestoring || !state.buckets.some((s) => s.backedUp > 0)}
                  >
                    Restore entire bucket from backup
                  </Button>
                </Stack>
              )}
            </CardContent>
          </Card>

          <Card variant="outlined" sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1 }}>Restore a single file</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Enter the bucket and storage path (as shown on the document/image record) to overwrite it
                with the backed-up copy.
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField
                  select
                  size="small"
                  label="Bucket"
                  value={restoreBucket ?? ''}
                  onChange={(e) => setRestoreBucket(e.target.value as BackupBucket)}
                  sx={{ minWidth: 220 }}
                  SelectProps={{ native: true }}
                >
                  <option value="" />
                  {(Object.keys(BUCKET_LABELS) as BackupBucket[]).map((b) => (
                    <option key={b} value={b}>{BUCKET_LABELS[b]}</option>
                  ))}
                </TextField>
                <TextField
                  size="small"
                  label="Storage path"
                  placeholder="e.g. order/123/packing-slip.pdf"
                  fullWidth
                  value={restorePath}
                  onChange={(e) => setRestorePath(e.target.value)}
                />
              </Stack>
              <Button
                sx={{ mt: 2 }}
                variant="outlined"
                startIcon={<RestoreIcon />}
                disabled={!restoreBucket || !restorePath.trim() || restoring}
                onClick={confirmRestoreFile}
              >
                {restoring ? 'Restoring…' : 'Restore file'}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {tab === 1 && (
        <>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="h6" sx={{ mb: 0.5 }}>Backup to disk</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Manual, on-demand copies you save yourself — to this computer, a network drive, or an
                external hard drive. Separate from the automatic mirror on the Cloud tab, which keeps
                running either way.
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Unlike the Cloud tab, every byte really is downloaded here, so a full export of all
                buckets moves ~16 GB and takes a while — keep this page open. Stopping it is safe:
                picking the same folder again skips whatever is already there at the right size and
                carries on from where it stopped.
              </Typography>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Button
                  variant="outlined"
                  startIcon={<DownloadIcon />}
                  onClick={downloadDb}
                  disabled={dbDownloading}
                >
                  {dbDownloading ? 'Downloading…' : 'Download database backup'}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<FolderIcon />}
                  onClick={exportStorageToDisk}
                  disabled={exportingDisk || restoringDisk}
                >
                  {exportingDisk ? `Exporting… ${exportProgress.toLocaleString()} files` : 'Export storage to folder'}
                </Button>
                <Button
                  variant="outlined"
                  color="warning"
                  startIcon={<UploadIcon />}
                  onClick={() => setConfirmRestoreDisk(true)}
                  disabled={exportingDisk || restoringDisk}
                >
                  {restoringDisk ? `Restoring… ${restoreProgress.toLocaleString()} files` : 'Restore storage from folder'}
                </Button>
                {(exportingDisk || restoringDisk) && (
                  <Button
                    variant="outlined"
                    color="warning"
                    startIcon={<StopIcon />}
                    onClick={() => { diskCancelledRef.current = true; setStopRequested(true); }}
                    disabled={stopRequested}
                    data-testid="backup-disk-stop"
                  >
                    Stop
                  </Button>
                )}
              </Stack>

              {dbDownloading && (
                <Box sx={{ mt: 2 }}>
                  <LinearProgress
                    variant={dbProgress?.totalTables ? 'determinate' : 'indeterminate'}
                    value={dbProgress?.totalTables ? Math.round((dbProgress.tableIndex / dbProgress.totalTables) * 100) : undefined}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {dbProgress
                      ? `Table ${dbProgress.tableIndex}${dbProgress.totalTables ? ` of ${dbProgress.totalTables}` : ''}: ${dbProgress.table}`
                      : 'Starting…'}
                  </Typography>
                </Box>
              )}

              {exportingDisk && (
                <Box sx={{ mt: 2 }} data-testid="backup-export-progress">
                  <LinearProgress
                    variant={exportTotal > 0 ? 'determinate' : 'indeterminate'}
                    value={exportTotal > 0 ? Math.min(100, Math.round((exportProgress / exportTotal) * 100)) : undefined}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {[
                      exportTotal > 0
                        ? `${exportProgress.toLocaleString()} of ${exportTotal.toLocaleString()} files`
                        : `${exportProgress.toLocaleString()} files`,
                      `${fmtDuration(diskElapsed)} elapsed`,
                      etaText(exportProgress, exportTotal, diskElapsed) || null,
                    ].filter(Boolean).join(' · ')}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                    {exportCurrentFile || 'Starting…'}
                  </Typography>
                </Box>
              )}

              {restoringDisk && (
                <Box sx={{ mt: 2 }} data-testid="backup-restore-progress">
                  {/* Indeterminate on purpose: the folder is walked lazily, so
                      there's no file count to divide by until it's finished. */}
                  <LinearProgress />
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {`${restoreProgress.toLocaleString()} files restored · ${fmtDuration(diskElapsed)} elapsed`}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                    {restoreCurrentFile || 'Starting…'}
                  </Typography>
                </Box>
              )}
            </CardContent>
          </Card>

          <Card variant="outlined" sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1 }}>Backup-to-disk history</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Last 7 days of database downloads and storage export/restore runs from this tab.
              </Typography>
              {diskHistory.length === 0 ? (
                <Typography variant="body2" color="text.secondary">No runs in the last 7 days.</Typography>
              ) : (
                <TableContainer sx={{ overflowX: 'auto' }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Job</TableCell>
                        <TableCell>Started</TableCell>
                        <TableCell>Finished</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Duration</TableCell>
                        <TableCell>Detail</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {diskHistory.map((run) => (
                        <TableRow key={run.cron_run_log_id}>
                          <TableCell>{JOB_LABELS[run.job_name] ?? run.job_name}</TableCell>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtTime(run.started_at)}</TableCell>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>
                            {run.finished_at ? fmtTime(run.finished_at) : <em>still running</em>}
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <HistoryStatusChip status={run.status} />
                              {run.status === 'error' && run.error && (
                                <Typography variant="caption" color="error.main" noWrap sx={{ maxWidth: 300 }}>
                                  {run.error}
                                </Typography>
                              )}
                            </Stack>
                          </TableCell>
                          <TableCell align="right">{fmtDuration(run.duration_ms)}</TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.secondary">{fmtDiskDetail(run.detail)}</Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={!!bulkRestoreBucket} onClose={() => !bulkRestoring && setBulkRestoreBucket(null)}>
        <DialogTitle>Restore entire bucket?</DialogTitle>
        <DialogContent>
          <TextField
            select
            size="small"
            label="Bucket"
            fullWidth
            sx={{ mt: 1, mb: 2 }}
            value={bulkRestoreBucket ?? ''}
            onChange={(e) => setBulkRestoreBucket(e.target.value as BackupBucket)}
            disabled={bulkRestoring}
            SelectProps={{ native: true }}
          >
            {state?.buckets.map((s) => (
              <option key={s.bucket} value={s.bucket} disabled={s.backedUp === 0}>
                {BUCKET_LABELS[s.bucket] ?? s.bucket}
              </option>
            ))}
          </TextField>
          <DialogContentText>
            This overwrites every object currently in <strong>{BUCKET_LABELS[bulkRestoreBucket as BackupBucket] ?? bulkRestoreBucket}</strong> with its
            backed-up copy. Anything uploaded after that copy was taken will be lost. This
            cannot be undone.
          </DialogContentText>
          {bulkRestoring && (
            <Box sx={{ mt: 2 }}>
              <LinearProgress />
              <Typography variant="caption" color="text.secondary">
                Restored {bulkRestored.toLocaleString()} so far…
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          {bulkRestoring ? (
            <Button onClick={() => { bulkCancelledRef.current = true; }} color="inherit">Stop after this batch</Button>
          ) : (
            <>
              <Button onClick={() => setBulkRestoreBucket(null)}>Cancel</Button>
              <Button onClick={confirmRestoreBucket} color="error" variant="contained">Restore</Button>
            </>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={confirmRestoreDisk} onClose={() => setConfirmRestoreDisk(false)}>
        <DialogTitle>Restore storage from a folder?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You'll pick a folder (one previously exported here) — every matching file inside it
            overwrites the live copy in <strong>record-docs</strong>, <strong>rep-docs</strong>, and{' '}
            <strong>item-images</strong>. Anything changed in storage since that export was taken will be
            lost. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRestoreDisk(false)}>Cancel</Button>
          <Button onClick={restoreStorageFromDisk} color="error" variant="contained">Choose folder & restore</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
