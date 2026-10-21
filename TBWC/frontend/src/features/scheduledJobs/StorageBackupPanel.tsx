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
  getStorageBackupStatus, getStorageBackupHistory, runStorageBackupNow,
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
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
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

const JOB_LABELS: Record<string, string> = {
  exportDatabase: 'Database download',
  exportStorage: 'Storage export',
  restoreStorage: 'Storage restore',
};

// detail jsonb shape differs by job: exportDatabase writes {tables, rows}
// (streamDatabaseDump), exportStorage/restoreStorage write {written} (the
// browser-driven folder loop reports its own count).
function fmtDiskDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return '—';
  const d = detail as { tables?: number; rows?: number; written?: number };
  if (typeof d.written === 'number') return `${d.written.toLocaleString()} files`;
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
  if (when || status) return [when, status].filter(Boolean).join(' · ');
  return JSON.stringify(b);
}

export default function StorageBackupPanel() {
  const [state, setState] = useState<StorageBackupState | null>(null);
  const [history, setHistory] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
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
    const startedAt = Date.now();
    let written = 0;
    try {
      const root = await (window as any).showDirectoryPicker();
      for (const bucket of EXPORT_BUCKETS) {
        let cursor: string | null = null;
        do {
          const page = await listLiveStorageObjects(bucket, cursor);
          for (const obj of page.objects) {
            setExportCurrentFile(`${bucket}/${obj.name}`);
            const bytes = await fetchLiveStorageObjectBytes(bucket, obj.name);
            const parts = obj.name.split('/');
            const dir = await dirFor(root, [bucket, ...parts.slice(0, -1)]);
            const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(bytes);
            await writable.close();
            written++;
            setExportProgress(written);
          }
          cursor = page.cursor;
        } while (cursor);
      }
      await logBackupRun('exportStorage', 'ok', { written }, Date.now() - startedAt);
      setMessage(`Exported ${written.toLocaleString()} files to the chosen folder.`);
      setDiskHistory(await getBackupHistory());
    } catch (e) {
      if (!isAbort(e)) {
        const msg = e instanceof Error ? e.message : 'Export failed';
        setError(msg);
        await logBackupRun('exportStorage', 'error', { written }, Date.now() - startedAt, msg).catch(() => {});
        setDiskHistory(await getBackupHistory().catch(() => diskHistory));
      }
    } finally {
      setExportingDisk(false);
    }
  }, [diskHistory]);

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
    const startedAt = Date.now();
    let written = 0;
    try {
      const root = await (window as any).showDirectoryPicker();
      for (const bucket of EXPORT_BUCKETS) {
        let bucketDir;
        try {
          bucketDir = await root.getDirectoryHandle(bucket);
        } catch {
          continue; // chosen folder has no subfolder for this bucket — nothing to restore
        }
        for await (const [path, fileHandle] of walkFiles(bucketDir)) {
          setRestoreCurrentFile(`${bucket}/${path}`);
          const file = await fileHandle.getFile();
          await restoreLiveStorageObjectBytes(bucket, path, await file.arrayBuffer());
          written++;
          setRestoreProgress(written);
        }
      }
      await logBackupRun('restoreStorage', 'ok', { written }, Date.now() - startedAt);
      setMessage(`Restored ${written.toLocaleString()} files from the chosen folder.`);
      setDiskHistory(await getBackupHistory());
    } catch (e) {
      if (!isAbort(e)) {
        const msg = e instanceof Error ? e.message : 'Restore failed';
        setError(msg);
        await logBackupRun('restoreStorage', 'error', { written }, Date.now() - startedAt, msg).catch(() => {});
        setDiskHistory(await getBackupHistory().catch(() => diskHistory));
      }
    } finally {
      setRestoringDisk(false);
    }
  }, [diskHistory]);

  useEffect(() => { load(); }, [load]);

  const runNow = useCallback(async () => {
    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      setState(await runStorageBackupNow());
      setMessage('Backup batch complete — pending counts above are now up to date.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backup run failed');
    } finally {
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
          <Card variant="outlined">
            <CardContent>
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

          <Card variant="outlined" sx={{ mt: 2 }}>
            <CardContent>
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
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Duration</TableCell>
                        <TableCell>Copied</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {history.map((run) => (
                        <TableRow key={run.cron_run_log_id}>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtTime(run.started_at)}</TableCell>
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
                  <Typography variant="caption" color="text.secondary">
                    Runs on the server on a schedule (nightly, ~2am Pacific) — this page does not need to be open.
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
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<CloudSyncIcon />}
                    onClick={runNow}
                    disabled={running || loading || paused}
                  >
                    {running ? 'Backing up…' : 'Back up now'}
                  </Button>
                </Stack>
              </Stack>

              {paused && (
                <Alert severity="warning" sx={{ mb: 2 }} data-testid="storage-backup-paused-alert">
                  Backup is stopped — no scheduled runs, and a run already in progress stops within a few
                  dozen files. Everything already mirrored stays backed up; resuming picks up where it left off.
                </Alert>
              )}

              {loading && <LinearProgress sx={{ mb: 2 }} />}

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
                        <Button
                          size="small"
                          startIcon={<RestoreIcon />}
                          onClick={() => setBulkRestoreBucket(s.bucket)}
                          disabled={bulkRestoring || s.backedUp === 0}
                        >
                          Restore entire bucket from backup
                        </Button>
                      </Box>
                    );
                  })}
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
                <Box sx={{ mt: 2 }}>
                  <LinearProgress
                    variant={exportTotal > 0 ? 'determinate' : 'indeterminate'}
                    value={exportTotal > 0 ? Math.min(100, Math.round((exportProgress / exportTotal) * 100)) : undefined}
                  />
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                    {exportCurrentFile || 'Starting…'}
                  </Typography>
                </Box>
              )}

              {restoringDisk && (
                <Box sx={{ mt: 2 }}>
                  <LinearProgress />
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
          <DialogContentText>
            This overwrites every object currently in <strong>{bulkRestoreBucket}</strong> with its
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
