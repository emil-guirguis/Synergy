/**
 * Settings > Scheduled Jobs. Click a job row to open its details on the
 * right: which Cloudflare Cron Trigger tier it runs on (editable — takes
 * effect on that tier's next tick, no redeploy; see worker/cronMonitor.ts
 * and migration 103) and, for jobs that have one, its alert settings
 * (migration 102) — recipients, email/in-app, threshold, throttle.
 *
 * A job stuck at 'running' long after its own schedule should have produced
 * a finish is the signature of the exact bug this page was born from — the
 * Worker invocation dying (CPU limit, uncaught throw) before the job's finish
 * row could be written.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Divider, Drawer,
  FormControlLabel, IconButton, MenuItem, Select, Stack, Switch, Table,
  TableBody, TableCell, TableContainer, TableHead, TableRow, TextField,
  Tooltip, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import {
  getCronLog, getAlertSettings, updateAlertSetting, updateJobTier, getCronHistory, runJobNow,
  type CronLog, type CronRun, type AlertSetting, type CronTier,
} from '../../services/settingsService';

// Storage backup has its own "Run now" on the Storage Backup tab (which also
// respects its pause switch and shows per-bucket progress) — no need to
// duplicate the control here.
const HAS_OWN_RUN_BUTTON = new Set(['backupStorage']);

const JOB_LABELS: Record<string, string> = {
  checkQbwcStale: 'QBWC stale check',
  runScheduledNotifications: 'Scheduled notifications',
  backfillDocumentIndex: 'Document text backfill',
  lockStaleReps: 'Rep re-verification lock',
  backupStorage: 'Storage backup',
};

const TIER_LABELS: Record<CronTier, string> = {
  frequent: 'Every 15 min',
  hourly: 'Hourly',
  daily: 'Daily (6am UTC)',
  // Cron Triggers run in UTC with no DST awareness — this is pinned to 2am
  // Pacific Standard Time, so it actually fires at 3am Pacific during
  // daylight saving rather than shifting to stay at 2am local.
  nightly: 'Every other day (~2am Pacific)',
  // Not a schedule — the stop switch (migration 107). A job parked here is
  // never named by jobsForTier(), and backupStorage also reads this while
  // running, so stopping it cancels a run in progress.
  off: 'Off (stopped)',
};

// Jobs heavy enough that sharing the "frequent" tier with others risks the
// exact CPU-limit bug this page exists to catch — warn, don't block, since
// backfillDocumentIndex now self-limits on elapsed time (aiSearch.ts).
const HEAVY_JOBS = new Set(['backfillDocumentIndex']);

// Which alert_setting row (if any) belongs to this job.
const JOB_ALERT_KEY: Record<string, string> = {
  checkQbwcStale: 'qbwc_stale',
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

// Each job's detail jsonb (migration 108) is shaped by that job's own
// return value — formatted per job_name rather than dumped as raw JSON.
// Falls back to a generic key: value join for anything not listed here.
function fmtDetail(jobName: string, detail: Record<string, unknown> | null): string {
  if (!detail) return '—';
  if (jobName === 'backfillDocumentIndex') {
    const { indexed, attempted } = detail as { indexed?: number; attempted?: number };
    return `${indexed ?? 0} indexed / ${attempted ?? 0} attempted`;
  }
  if (jobName === 'backupStorage') {
    const { copied, failed, stopped } = detail as { copied?: number; failed?: number; stopped?: boolean };
    return `${copied ?? 0} copied${failed ? `, ${failed} failed` : ''}${stopped ? ' (stopped early)' : ''}`;
  }
  return Object.entries(detail).map(([k, v]) => `${k}: ${v}`).join(', ');
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
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [history, setHistory] = useState<CronRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [runningJob, setRunningJob] = useState<string | null>(null);

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

  useEffect(() => {
    if (!selectedJob) { setHistory([]); return; }
    let cancelled = false;
    setHistoryLoading(true);
    getCronHistory(selectedJob)
      .then((h) => { if (!cancelled) setHistory(h); })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [selectedJob]);

  const avgFor = (job: string) => log?.avg.find((a) => a.job_name === job);
  const tierFor = (job: string) => log?.jobs.find((j) => j.job_name === job)?.cron_tier;
  const runFor = (job: string) => log?.latest.find((r) => r.job_name === job) ?? null;
  const alertFor = (job: string) => alerts.find((a) => a.alert_key === JOB_ALERT_KEY[job]);

  const saveTier = useCallback(async (jobName: string, tier: CronTier) => {
    setSaving(jobName);
    setError(null);
    try {
      const updated = await updateJobTier(jobName, tier);
      setLog((prev) => prev && {
        ...prev,
        jobs: prev.jobs.map((j) => (j.job_name === jobName ? updated : j)),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save schedule');
    } finally {
      setSaving(null);
    }
  }, []);

  const runNow = useCallback(async (jobName: string) => {
    setRunningJob(jobName);
    setError(null);
    try {
      await runJobNow(jobName);
      await load();
      setHistory(await getCronHistory(jobName));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run job');
    } finally {
      setRunningJob(null);
    }
  }, [load]);

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

  const selectedTier = selectedJob ? tierFor(selectedJob) : undefined;
  const selectedRun = selectedJob ? runFor(selectedJob) : null;
  const selectedAlert = selectedJob ? alertFor(selectedJob) : undefined;

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
        <Card variant="outlined" data-testid="cron-job-table">
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>Scheduled jobs</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Click a job to view its schedule and settings.
            </Typography>
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Job</TableCell>
                    <TableCell>Runs</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell align="right">Duration</TableCell>
                    <TableCell align="right">Avg (24h)</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {Object.keys(JOB_LABELS).map((jobName) => {
                    const run = runFor(jobName);
                    const avg = avgFor(jobName);
                    const tier = tierFor(jobName);
                    return (
                      <TableRow
                        key={jobName}
                        hover
                        onClick={() => setSelectedJob(jobName)}
                        sx={{ cursor: 'pointer' }}
                        data-testid={`cron-job-row-${jobName}`}
                      >
                        <TableCell>{JOB_LABELS[jobName]}</TableCell>
                        <TableCell>{tier ? TIER_LABELS[tier] : '—'}</TableCell>
                        <TableCell><StatusChip run={run} schedule={tier ? TIER_LABELS[tier] : 'unknown'} /></TableCell>
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

      <Drawer anchor="right" open={!!selectedJob} onClose={() => setSelectedJob(null)}>
        <Box sx={{ width: 560, p: 2.5 }} data-testid="cron-job-drawer">
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
            <Typography variant="h6">{selectedJob ? JOB_LABELS[selectedJob] : ''}</Typography>
            <IconButton size="small" onClick={() => setSelectedJob(null)}><CloseIcon fontSize="small" /></IconButton>
          </Stack>

          {selectedJob && (
            <>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>Schedule</Typography>
              <Select
                size="small"
                fullWidth
                value={selectedTier ?? ''}
                disabled={saving === selectedJob}
                onChange={(e) => saveTier(selectedJob, e.target.value as CronTier)}
                sx={{ mb: 1 }}
              >
                {(Object.keys(TIER_LABELS) as CronTier[]).map((tier) => (
                  <MenuItem key={tier} value={tier}>{TIER_LABELS[tier]}</MenuItem>
                ))}
              </Select>
              {selectedTier === 'off' && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  This job is stopped — it will not run on any schedule until a schedule is picked
                  here again.
                </Alert>
              )}
              {HEAVY_JOBS.has(selectedJob) && selectedTier === 'frequent' && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  This job does real CPU work. Running it every 15 min alongside other jobs on the
                  same tier risks hitting Cloudflare's CPU limit — the exact bug this page exists to
                  catch. Hourly or daily is safer.
                </Alert>
              )}
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
                Change takes effect on this schedule's next tick — no redeploy needed.
              </Typography>

              <Divider sx={{ mb: 2 }} />

              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="subtitle2" color="text.secondary">Last run</Typography>
                {!HAS_OWN_RUN_BUTTON.has(selectedJob) && (
                  <Tooltip title={selectedTier === 'off' ? "Resume this job's schedule before running it" : ''}>
                    <span>
                      <Button
                        size="small"
                        startIcon={<PlayArrowIcon />}
                        onClick={() => runNow(selectedJob)}
                        disabled={runningJob === selectedJob || selectedTier === 'off'}
                        data-testid={`cron-job-run-now-${selectedJob}`}
                      >
                        {runningJob === selectedJob ? 'Running…' : 'Run now'}
                      </Button>
                    </span>
                  </Tooltip>
                )}
              </Stack>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <StatusChip run={selectedRun} schedule={selectedTier ? TIER_LABELS[selectedTier] : 'unknown'} />
                <Typography variant="body2" color="text.secondary">
                  {selectedRun ? `${fmtTime(selectedRun.started_at)} · ${fmtDuration(selectedRun.duration_ms)}` : 'never run yet'}
                </Typography>
              </Stack>

              <Divider sx={{ mb: 2 }} />

              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>History (7 days)</Typography>
              {historyLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={20} /></Box>
              ) : history.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>No runs in the last 7 days.</Typography>
              ) : (
                <TableContainer sx={{ mb: 2, maxHeight: 280, overflowY: 'auto' }}>
                  <Table size="small" data-testid="cron-job-history-table">
                    <TableHead>
                      <TableRow>
                        <TableCell>Started</TableCell>
                        <TableCell align="right">Duration</TableCell>
                        <TableCell>Detail</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {history.map((run) => (
                        <TableRow key={run.cron_run_log_id}>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              <StatusChip run={run} schedule="" />
                              <Typography variant="caption">{fmtTime(run.started_at)}</Typography>
                            </Stack>
                          </TableCell>
                          <TableCell align="right">{fmtDuration(run.duration_ms)}</TableCell>
                          <TableCell>
                            <Typography variant="caption" color={run.status === 'error' ? 'error.main' : 'text.secondary'}>
                              {run.status === 'error' ? run.error ?? 'error' : fmtDetail(run.job_name, run.detail)}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}

              {selectedAlert && (
                <>
                  <Divider sx={{ mb: 2 }} />
                  <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                    {ALERT_LABELS[selectedAlert.alert_key] ?? selectedAlert.alert_key}
                  </Typography>
                  <Stack spacing={1} sx={{ mb: 2 }}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={selectedAlert.enabled}
                          onChange={(e) => saveAlert(selectedAlert.alert_key, { enabled: e.target.checked })}
                          disabled={saving === selectedAlert.alert_key}
                        />
                      }
                      label="Enabled"
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={selectedAlert.notify_email}
                          onChange={(e) => saveAlert(selectedAlert.alert_key, { notify_email: e.target.checked })}
                          disabled={saving === selectedAlert.alert_key || !selectedAlert.enabled}
                        />
                      }
                      label="Email"
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={selectedAlert.notify_inapp}
                          onChange={(e) => saveAlert(selectedAlert.alert_key, { notify_inapp: e.target.checked })}
                          disabled={saving === selectedAlert.alert_key || !selectedAlert.enabled}
                        />
                      }
                      label="In-app notification"
                    />
                  </Stack>
                  <Stack spacing={2}>
                    <TextField
                      label="Stale after (minutes)"
                      type="number"
                      size="small"
                      fullWidth
                      defaultValue={selectedAlert.threshold_minutes ?? ''}
                      disabled={saving === selectedAlert.alert_key}
                      onBlur={(e) => {
                        const v = e.target.value === '' ? null : Number(e.target.value);
                        if (v !== selectedAlert.threshold_minutes) saveAlert(selectedAlert.alert_key, { threshold_minutes: v });
                      }}
                    />
                    <TextField
                      label="Re-alert every (hours)"
                      type="number"
                      size="small"
                      fullWidth
                      defaultValue={selectedAlert.throttle_hours}
                      disabled={saving === selectedAlert.alert_key}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isNaN(v) && v !== selectedAlert.throttle_hours) {
                          saveAlert(selectedAlert.alert_key, { throttle_hours: v });
                        }
                      }}
                    />
                    <TextField
                      label="Recipients holding permission"
                      size="small"
                      fullWidth
                      defaultValue={selectedAlert.recipient_permission ?? ''}
                      disabled={saving === selectedAlert.alert_key}
                      helperText="Everyone whose role grants this permission"
                      onBlur={(e) => {
                        const v = e.target.value.trim() || null;
                        if (v !== selectedAlert.recipient_permission) saveAlert(selectedAlert.alert_key, { recipient_permission: v });
                      }}
                    />
                  </Stack>
                </>
              )}
            </>
          )}
        </Box>
      </Drawer>
    </Box>
  );
}
