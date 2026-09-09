/**
 * QB Sync dashboard — what the QuickBooks Web Connector synced, when, and how
 * many rows, per object. Stat tiles (staged totals + last run) over a recent-run
 * log table. Read-only; data comes from /api/qb-sync (admin-only).
 *
 * Status is always icon + label, never color alone.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Card, CardContent, Chip, CircularProgress, IconButton, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import UploadIcon from '@mui/icons-material/Upload';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { getSummary, getRuns, type SyncRun, type SyncSummary } from '../../services/qbSyncService';

/** Tiles shown on dashboard; Payment/Vendor excluded per request. */
const OBJECTS = ['Customer', 'SalesRep', 'Item', 'SalesOrder', 'Invoice'];

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

function ObjectTile({ object, summary }: { object: string; summary: SyncSummary }) {
  const total = summary.totals[object];
  const lastPull = summary.latest.find((r) => r.object_type === object && r.direction === 'pull');
  const lastPush = summary.latest.find((r) => r.object_type === object && r.direction === 'push');
  const lastErr = summary.latest.find((r) => r.object_type === object && r.direction === 'error');
  // An error run newer than the last successful pull/push means the object is unhealthy.
  const newestOk = [lastPull, lastPush].filter(Boolean)
    .map((r) => new Date(r!.created_at).getTime())
    .sort((a, b) => b - a)[0] ?? 0;
  const failing = !!lastErr && new Date(lastErr.created_at).getTime() > newestOk;

  return (
    <Card variant="outlined" data-testid={`qb-sync-tile-${object}`} sx={{ minWidth: 210, flex: '1 1 210px' }}>
      <CardContent sx={{ pb: '12px !important' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="overline" color="text.secondary">{LABELS[object] ?? object}</Typography>
          {failing && (
            <Tooltip title={lastErr!.error ?? 'sync error'}>
              <ErrorOutlineIcon color="error" fontSize="small" />
            </Tooltip>
          )}
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
          {OBJECTS.map((o) => <ObjectTile key={o} object={o} summary={summary} />)}
        </Stack>
      )}

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
                        <TableCell>{LABELS[r.object_type] ?? r.object_type}</TableCell>
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
