/**
 * QB Sync dashboard — what the QuickBooks Web Connector synced, when, and how
 * many rows, per object. Stat tiles (staged totals + last run) over a recent-run
 * log table. Data comes from /api/qb-sync (admin-only).
 *
 * Each tile carries a reload button that queues a full re-pull of that one
 * table: the next Web Connector update asks QB for every record instead of only
 * what changed. It is a queue, not an immediate sync — the Web Connector runs on
 * its own schedule — and it is non-destructive, since a pull upserts QB-owned
 * columns only and never deletes a staging row (TBWC-owned data like item
 * images, order build notes/money and attachments is untouched).
 *
 * Status is always icon + label, never color alone.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogContentText, DialogTitle, IconButton, Snackbar, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import DownloadIcon from '@mui/icons-material/Download';
import UploadIcon from '@mui/icons-material/Upload';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { getSummary, getRuns, requestReload, type SyncRun, type SyncSummary } from '../../services/qbSyncService';

/** Tiles shown on dashboard; Vendor excluded per request. Payment (AR) re-added. */
const OBJECTS = ['Customer', 'SalesRep', 'Item', 'SalesOrder', 'Invoice', 'Payment'];

const RUNS_PAGE_SIZE = 100;

const LABELS: Record<string, string> = {
  Customer: 'Customers', Vendor: 'Vendors', SalesRep: 'Sales Reps', Item: 'Items',
  Invoice: 'Invoices', Payment: 'Payments', SalesOrder: 'Sales Orders', Estimate: 'Estimates',
};

// Sync timestamps are stored UTC; render them in the viewer's own local zone
// (browser default) with a short zone label.
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleString('en-US', { timeZoneName: 'short' });
}

function DirectionChip({ direction }: { direction: SyncRun['direction'] }) {
  if (direction === 'error') {
    return <Chip size="small" icon={<ErrorOutlineIcon />} label="error" color="error" variant="outlined" />;
  }
  const pull = direction === 'pull';
  return (
    <Chip
      size="small"
      icon={pull ? <DownloadIcon /> : <UploadIcon />}
      label={pull ? 'pull (QB → TBWC)' : 'push (TBWC → QB)'}
      variant="outlined"
    />
  );
}

function RunStatus({ run }: { run: SyncRun }) {
  if (run.error) {
    return (
      <Tooltip title={run.error}>
        <Chip size="small" icon={<ErrorOutlineIcon />} label="failed" color="error" />
      </Tooltip>
    );
  }
  const empty = run.status_code === '1' || run.rows_processed === 0;
  const label = empty ? 'ok' : `ok (${run.rows_processed} applied)`;
  return (
    <Tooltip title={label}>
      <Chip
        size="small"
        icon={<CheckCircleOutlineIcon />}
        label={label}
        color="success"
        variant="outlined"
      />
    </Tooltip>
  );
}

function ObjectTile({
  object,
  summary,
  onReload,
}: {
  object: string;
  summary: SyncSummary;
  onReload: (object: string) => void;
}) {
  const total = summary.totals[object];
  const lastPull = summary.latest.find((r) => r.object_type === object && r.direction === 'pull');
  const lastPush = summary.latest.find((r) => r.object_type === object && r.direction === 'push');
  const lastErr = summary.latest.find((r) => r.object_type === object && r.direction === 'error');
  // An error run newer than the last successful pull/push means the object is unhealthy.
  const newestOk = [lastPull, lastPush].filter(Boolean)
    .map((r) => new Date(r!.created_at).getTime())
    .sort((a, b) => b - a)[0] ?? 0;
  const failing = !!lastErr && new Date(lastErr.created_at).getTime() > newestOk;
  const reloadQueued = summary.reloads?.[object] ?? null;

  return (
    <Card variant="outlined" data-testid={`qb-sync-tile-${object}`} sx={{ minWidth: 210, flex: '1 1 210px' }}>
      <CardContent sx={{ pb: '12px !important' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="overline" color="text.secondary">{LABELS[object] ?? object}</Typography>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            {failing && (
              <Tooltip title={lastErr!.error ?? 'sync error'}>
                <ErrorOutlineIcon color="error" fontSize="small" />
              </Tooltip>
            )}
            <Tooltip title={reloadQueued
              ? `Full reload queued ${fmtTime(reloadQueued)} — runs on the next Web Connector update`
              : 'Reload this table in full from QuickBooks'}>
              <IconButton
                size="small"
                onClick={() => onReload(object)}
                data-testid={`qb-sync-reload-${object}`}
                aria-label={`Reload ${LABELS[object] ?? object} from QuickBooks`}
              >
                {reloadQueued ? <HourglassTopIcon fontSize="small" color="warning" /> : <CloudSyncIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        <Typography variant="h4" component="div">
          {total == null ? '—' : total.toLocaleString()}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div">
          rows staged
        </Typography>
        {lastPush && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
            ↑ last push: {lastPush.rows_processed} @ {fmtTime(lastPush.created_at)}
          </Typography>
        )}
        {reloadQueued && (
          <Chip
            size="small"
            icon={<HourglassTopIcon />}
            label="full reload queued"
            color="warning"
            variant="outlined"
            sx={{ mt: 1 }}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function QbSyncDashboardPage() {
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Confirm before queueing: a full reload re-pulls every record of that table
  // on the next Web Connector run, which for Invoice is ~7.8k records across
  // many iterator pages.
  const [confirmReload, setConfirmReload] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadRuns = useCallback(async (p: number) => {
    const runPage = await getRuns(undefined, RUNS_PAGE_SIZE, p * RUNS_PAGE_SIZE);
    setRuns(runPage.items);
    setRunsTotal(runPage.total);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s] = await Promise.all([getSummary(), loadRuns(0)]);
      setSummary(s);
      setPage(0);
    } catch (e: any) {
      setError(e.message || 'Failed to load sync status');
    } finally {
      setLoading(false);
    }
  }, [loadRuns]);

  useEffect(() => { load(); }, [load]);

  const doReload = useCallback(async () => {
    const object = confirmReload;
    if (!object) return;
    setReloading(true);
    try {
      await requestReload(object);
      setConfirmReload(null);
      setToast(`Full reload queued for ${LABELS[object] ?? object}. It runs on the next Web Connector update.`);
      await load();
    } catch (e: any) {
      setError(e.message || 'Failed to queue reload');
      setConfirmReload(null);
    } finally {
      setReloading(false);
    }
  }, [confirmReload, load]);

  const handlePageChange = useCallback(async (_e: unknown, newPage: number) => {
    setPage(newPage);
    try {
      await loadRuns(newPage);
    } catch (e: any) {
      setError(e.message || 'Failed to load sync runs');
    }
  }, [loadRuns]);

  return (
    <Box data-testid="qb-sync-dashboard" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5">QuickBooks Sync</Typography>
        </Box>
        <Tooltip title="Refresh">
          <span>
            <IconButton onClick={load} disabled={loading} data-testid="qb-sync-refresh">
              <RefreshIcon sx={loading ? {
                animation: 'qb-sync-spin 0.8s linear infinite',
                '@keyframes qb-sync-spin': { to: { transform: 'rotate(360deg)' } },
              } : undefined} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && !summary && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {summary && (
        <Stack direction="row" flexWrap="wrap" gap={2} sx={{ mb: 3 }}>
          {OBJECTS.map((o) => (
            <ObjectTile key={o} object={o} summary={summary} onReload={setConfirmReload} />
          ))}
        </Stack>
      )}

      <Dialog open={!!confirmReload} onClose={() => setConfirmReload(null)}>
        <DialogTitle>
          Reload {confirmReload ? LABELS[confirmReload] ?? confirmReload : ''} from QuickBooks?
        </DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            The next Web Connector update will re-pull every record of this table instead of only
            what changed — slow for large tables, and it only starts when the Web Connector next
            runs.
            <Box component="p" sx={{ mb: 0 }}>
              Nothing is deleted or overwritten outside QuickBooks' own fields: item images and
              notes, order build notes, dates and money, and every attachment stay as they are.
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmReload(null)} disabled={reloading}>Cancel</Button>
          <Button onClick={doReload} variant="contained" disabled={reloading} data-testid="qb-sync-reload-confirm">
            {reloading ? 'Queueing…' : 'Queue reload'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        message={toast ?? ''}
      />

      {summary && (
        <Card variant="outlined" data-testid="qb-sync-runs">
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>Recent sync activity</Typography>
            {runs.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No sync runs logged yet. Run an update in the QuickBooks Web Connector, then refresh.
              </Typography>
            ) : (
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>When</TableCell>
                      <TableCell>Object</TableCell>
                      <TableCell>Direction</TableCell>
                      <TableCell align="right">Rows</TableCell>
                      <TableCell>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {runs.map((r) => (
                      <TableRow key={r.qbwc_sync_run_id} hover>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtTime(r.created_at)}</TableCell>
                        <TableCell>
                          {LABELS[r.object_type] ?? r.object_type}
                          {r.detail && (
                            <Typography variant="caption" color="text.secondary" component="div">
                              {r.detail}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell><DirectionChip direction={r.direction} /></TableCell>
                        <TableCell align="right">{r.rows_processed}</TableCell>
                        <TableCell><RunStatus run={r} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
            {runsTotal > RUNS_PAGE_SIZE && (
              <TablePagination
                component="div"
                count={runsTotal}
                page={page}
                onPageChange={handlePageChange}
                rowsPerPage={RUNS_PAGE_SIZE}
                rowsPerPageOptions={[RUNS_PAGE_SIZE]}
                data-testid="qb-sync-runs-pagination"
              />
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}

export default QbSyncDashboardPage;
