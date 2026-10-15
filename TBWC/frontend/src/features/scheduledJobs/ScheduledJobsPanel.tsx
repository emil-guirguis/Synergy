/**
 * Settings > Scheduled Jobs. Two things worker/index.ts's scheduled() jobs
 * had no visibility into until migration 102 (cron_run_log, alert_setting):
 * whether each cron job actually ran and how long it took, and who the
 * QBWC-down alert notifies without needing a redeploy to change.
 *
 * A job stuck at 'running' long after its own schedule should have produced
 * a finish is the signature of the exact bug this page was born from — the
 * Worker invocation dying (CPU limit, uncaught throw) before the job's finish
 * row could be written. See worker/cronMonitor.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Card, CardContent, Chip, CircularProgress, FormControlLabel,
  IconButton, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import {
  getCronLog, getAlertSettings, updateAlertSetting,
  type CronLog, type CronRun, type AlertSetting,
} from '../../services/settingsService';

const JOB_LABELS: Record<string, string> = {
  checkQbwcStale: 'QBWC stale check',
  runScheduledNotifications: 'Scheduled notifications',
  backfillDocumentIndex: 'Document text backfill',
  lockStaleReps: 'Rep re-verification lock',
};

// Matches wrangler.toml's [triggers]/[env.production.triggers] crons —
// shown so a job with no run yet reads as "hasn't hit its schedule since
// deploy" rather than looking broken/missing.
const JOB_SCHEDULE: Record<string, string> = {
  checkQbwcStale: 'every 15 min',
  runScheduledNotifications: 'every 15 min',
  backfillDocumentIndex: 'hourly, on the hour',
  lockStaleReps: 'daily, 6am UTC',
};

const ALERT_LABELS: Record<string, string> = {
  qbwc_stale: 'QuickBooks connection alert',
};

function fmtTime(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleString('en-US', { timeZoneName: 'short' });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function StatusChip({ run, schedule }: { run: CronRun | null; schedule: string }) {
  if (!run) {
    return (
      <Tooltip title={`No run logged yet — scheduled ${schedule}`}>
        <Chip size="small" label="never run" variant="outlined" />
      </Tooltip>
    );
  }
  if (run.status === 'running') {
    return (
      <Tooltip title="Started but never recorded a finish — the invocation may have been cut off mid-run (e.g. a CPU limit)">
        <Chip size="small" icon={<HourglassTopIcon />} label="running" color="warning" variant="outlined" />
      </Tooltip>
    );
  }
  if (run.status === 'error') {
    return (
      <Tooltip title={run.error ?? 'error'}>
        <Chip size="small" icon={<ErrorOutlineIcon />} label="error" color="error" />
      </Tooltip>
    );
  }
  return <Chip size="small" icon={<CheckCircleOutlineIcon />} label="ok" color="success" variant="outlined" />;
}

export default function ScheduledJobsPanel() {
  const [log, setLog] = useState<CronLog | null>(null);
  const [alerts, setAlerts] = useState<AlertSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [l, a] = await Promise.all([getCronLog(), getAlertSettings()]);
      setLog(l);
      setAlerts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load scheduled jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const avgFor = (job: string) => log?.avg.find((a) => a.job_name === job);

  const saveAlert = useCallback(async (alertKey: string, updates: Partial<AlertSetting>) => {
    setSaving(alertKey);
    setError(null);
    try {
      const updated = await updateAlertSetting(alertKey, updates);
      setAlerts((prev) => prev.map((a) => (a.alert_key === alertKey ? updated : a)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save alert setting');
    } finally {
      setSaving(null);
    }
  }, []);

  return (
    <Box data-testid="scheduled-jobs-panel">
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
        <Tooltip title="Refresh">
          <span>
            <IconButton onClick={load} disabled={loading} size="small" data-testid="scheduled-jobs-refresh">
              <RefreshIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && !log && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
      )}

      {log && (
        <Card variant="outlined" sx={{ mb: 2 }} data-testid="cron-job-table">
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>Last run per job</Typography>
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Job</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell align="right">Duration</TableCell>
                    <TableCell align="right">Avg (24h)</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {Object.keys(JOB_LABELS).map((jobName) => {
                    const run = log.latest.find((r) => r.job_name === jobName) ?? null;
                    const avg = avgFor(jobName);
                    return (
                      <TableRow key={jobName} hover>
                        <TableCell>{JOB_LABELS[jobName]}</TableCell>
                        <TableCell><StatusChip run={run} schedule={JOB_SCHEDULE[jobName]} /></TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{run ? fmtTime(run.started_at) : '—'}</TableCell>
                        <TableCell align="right">{run ? fmtDuration(run.duration_ms) : '—'}</TableCell>
                        <TableCell align="right">
                          {avg ? `${fmtDuration(avg.avg_ms)} (${avg.runs} runs)` : '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}

      {alerts.map((alert) => (
        <Card variant="outlined" key={alert.alert_key} sx={{ mb: 2 }} data-testid={`alert-setting-${alert.alert_key}`}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              {ALERT_LABELS[alert.alert_key] ?? alert.alert_key}
            </Typography>
            <Stack direction="row" flexWrap="wrap" gap={2} sx={{ mb: 2 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={alert.enabled}
                    onChange={(e) => saveAlert(alert.alert_key, { enabled: e.target.checked })}
                    disabled={saving === alert.alert_key}
                  />
                }
                label="Enabled"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={alert.notify_email}
                    onChange={(e) => saveAlert(alert.alert_key, { notify_email: e.target.checked })}
                    disabled={saving === alert.alert_key || !alert.enabled}
                  />
                }
                label="Email"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={alert.notify_inapp}
                    onChange={(e) => saveAlert(alert.alert_key, { notify_inapp: e.target.checked })}
                    disabled={saving === alert.alert_key || !alert.enabled}
                  />
                }
                label="In-app notification"
              />
            </Stack>
            <Stack direction="row" flexWrap="wrap" gap={2}>
              <TextField
                label="Stale after (minutes)"
                type="number"
                size="small"
                defaultValue={alert.threshold_minutes ?? ''}
                disabled={saving === alert.alert_key}
                onBlur={(e) => {
                  const v = e.target.value === '' ? null : Number(e.target.value);
                  if (v !== alert.threshold_minutes) saveAlert(alert.alert_key, { threshold_minutes: v });
                }}
                sx={{ width: 190 }}
              />
              <TextField
                label="Re-alert every (hours)"
                type="number"
                size="small"
                defaultValue={alert.throttle_hours}
                disabled={saving === alert.alert_key}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v) && v !== alert.throttle_hours) saveAlert(alert.alert_key, { throttle_hours: v });
                }}
                sx={{ width: 190 }}
              />
              <TextField
                label="Recipients holding permission"
                size="small"
                defaultValue={alert.recipient_permission ?? ''}
                disabled={saving === alert.alert_key}
                helperText="Everyone whose role grants this permission"
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== alert.recipient_permission) saveAlert(alert.alert_key, { recipient_permission: v });
                }}
                sx={{ width: 260 }}
              />
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Box>
  );
}
