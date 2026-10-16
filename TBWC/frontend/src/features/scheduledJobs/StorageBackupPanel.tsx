/**
 * Settings > Storage Backup. Supabase's own daily backups cover Postgres
 * only — the file bytes in record-docs/rep-docs/item-images aren't backed
 * up anywhere else, so worker/storageBackup.ts mirrors them into a
 * Cloudflare R2 bucket (one bounded batch per scheduled cron tick; see
 * migrations 105/106). This panel shows per-bucket progress, a manual "back
 * up now" action, a stop/resume switch, and restore (one file, or a whole
 * bucket) from the mirror.
 *
 * The copying itself happens in the Worker on a Cron Trigger, so it keeps
 * going with this page closed — this panel only observes it and flips
 * switches. Stop writes scheduled_job.cron_tier = 'off' (migration 107),
 * which skips future ticks and also makes a tick already running bail at its
 * next batch boundary. Whole-bucket restore is the one thing that genuinely
 * needs this tab open: its loop lives in confirmRestoreBucket below.
 *
 * Also shows the last 7 days of backup run history (dates/times/status) —
 * cron_run_log's own retention (pruneCronRunLog, daily) keeps that window
 * from growing forever; see migration 106.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, LinearProgress, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import RestoreIcon from '@mui/icons-material/Restore';
import StopIcon from '@mui/icons-material/Stop';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import {
  getStorageBackupStatus, getStorageBackupHistory, runStorageBackupNow,
  restoreStorageObject, restoreStorageBucketBatch, setStorageBackupPaused,
  type StorageBackupState, type BackupBucket, type CronRun,
} from '../../services/settingsService';

const BUCKET_LABELS: Record<BackupBucket, string> = {
  'record-docs': 'Order/quote/invoice documents',
  'rep-docs': 'Rep resources',
  'item-images': 'Inventory item images',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { timeZoneName: 'short' });
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([getStorageBackupStatus(), getStorageBackupHistory()]);
      setState(s);
      setHistory(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load backup status');
    } finally {
      setLoading(false);
    }
  }, []);

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

  return (
    <Box data-testid="storage-backup-panel">
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {message && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMessage(null)}>{message}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
            <Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="h6">Storage backup</Typography>
                {paused && (
                  <Chip size="small" label="Stopped" color="warning" data-testid="storage-backup-paused-chip" />
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Mirrors file bytes into Cloudflare R2. Supabase's own backups cover the database only.
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
              dozen files. Everything already mirrored stays in R2; resuming picks up where it left off.
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
            with the backed-up copy from R2.
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

      <Card variant="outlined" sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>Backup history</Typography>
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!bulkRestoreBucket} onClose={() => !bulkRestoring && setBulkRestoreBucket(null)}>
        <DialogTitle>Restore entire bucket?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This overwrites every object currently in <strong>{bulkRestoreBucket}</strong> with its
            backed-up copy from R2. Anything uploaded after that copy was taken will be lost. This
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
    </Box>
  );
}
