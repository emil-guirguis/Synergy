/**
 * Visibility into worker/index.ts's scheduled() jobs — public.cron_run_log
 * (migration 102). Powers Settings > Scheduled Jobs.
 *
 * runJob() wraps one job with a start row (status 'running') and a finish
 * row (status 'ok'/'error') so a job that never finishes — the exact failure
 * mode that let a QBWC-down alert silently stop firing (backfillDocumentIndex
 * eating the whole tick's CPU budget before checkQbwcStale could run) — shows
 * up as a row stuck at 'running' instead of nothing at all.
 */
import { Env, execQuery } from './db';

/** A 'running' row older than this is from an invocation that's definitely
 *  dead, not just slow — every job's own MAX_TICK_MILLIS/maxMillis budget is
 *  well under this, so a live run never trips it. Auto-heals the exact
 *  "stuck at running forever" signature (see 2026-10-21's backfillDocumentIndex
 *  incident, fixed with index_attempts) without a human re-running the manual
 *  cleanup UPDATE every time an isolate gets CPU-killed. */
const STALE_RUNNING_MILLIS = 10 * 60 * 1000;

async function healStaleRunningRows(env: Env, jobName: string): Promise<void> {
  await execQuery(
    env,
    `UPDATE public.cron_run_log
        SET status = 'error', finished_at = now(), error = 'auto-cleared: previous invocation never finished (likely CPU-limit kill)'
      WHERE job_name = $1 AND status = 'running' AND started_at < now() - ($2 || ' milliseconds')::interval`,
    [jobName, STALE_RUNNING_MILLIS],
    'cron.runLog.healStale'
  ).catch((e) => console.error(`[cron] stale-running cleanup failed for ${jobName}:`, e instanceof Error ? e.message : e));
}

export async function runJob(
  env: Env,
  jobName: string,
  fn: () => Promise<Record<string, unknown> | void>
): Promise<void> {
  await healStaleRunningRows(env, jobName);
  const startedAt = Date.now();
  let logId: number | null = null;
  try {
    const r = await execQuery(
      env,
      `INSERT INTO public.cron_run_log (job_name, status) VALUES ($1, 'running') RETURNING cron_run_log_id`,
      [jobName],
      'cron.runLog.start'
    );
    logId = r.rows[0]?.cron_run_log_id ?? null;
  } catch (e) {
    console.error(`[cron] cron_run_log start write failed for ${jobName}:`, e instanceof Error ? e.message : e);
  }

  try {
    const detail = await fn();
    if (logId != null) {
      await execQuery(
        env,
        `UPDATE public.cron_run_log SET status = 'ok', finished_at = now(), duration_ms = $2, detail = $3 WHERE cron_run_log_id = $1`,
        [logId, Date.now() - startedAt, detail ?? null],
        'cron.runLog.finishOk'
      ).catch((e) => console.error(`[cron] cron_run_log finish write failed for ${jobName}:`, e instanceof Error ? e.message : e));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron] ${jobName} failed:`, message);
    if (logId != null) {
      await execQuery(
        env,
        `UPDATE public.cron_run_log SET status = 'error', finished_at = now(), duration_ms = $2, error = $3 WHERE cron_run_log_id = $1`,
        [logId, Date.now() - startedAt, message],
        'cron.runLog.finishError'
      ).catch((e) => console.error(`[cron] cron_run_log finish write failed for ${jobName}:`, e instanceof Error ? e.message : e));
    }
  }
}

export interface CronRunRow {
  cron_run_log_id: number;
  job_name: string;
  status: 'running' | 'ok' | 'error';
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  /** Job-shaped result of a successful run (e.g. backfillDocumentIndex's
   *  {indexed, attempted}) — null for 'running'/'error' rows and runs from
   *  before migration 108. */
  detail: Record<string, unknown> | null;
}

/** Most recent row per job_name — the dashboard's "last run" tiles. */
export async function latestRunPerJob(env: Env): Promise<CronRunRow[]> {
  const { rows } = await execQuery(
    env,
    `SELECT DISTINCT ON (job_name) cron_run_log_id, job_name, status, error, started_at, finished_at, duration_ms, detail
       FROM public.cron_run_log
      ORDER BY job_name, started_at DESC`,
    [],
    'cron.runLog.latestPerJob'
  );
  return rows;
}

/** Recent history across all jobs, newest first — the dashboard's run table. */
export async function recentRuns(env: Env, limit = 100): Promise<CronRunRow[]> {
  const { rows } = await execQuery(
    env,
    `SELECT cron_run_log_id, job_name, status, error, started_at, finished_at, duration_ms, detail
       FROM public.cron_run_log
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit],
    'cron.runLog.recent'
  );
  return rows;
}

/** One job's own run history within the retention window — unlike recentRuns
 *  (shared 100-row cap across every job), a frequent-tier job elsewhere can't
 *  crowd this one out. Backs the Storage Backup panel's history table, and
 *  Scheduled Jobs' per-job drawer. */
export async function recentRunsForJob(env: Env, jobName: string, sinceDays = 7): Promise<CronRunRow[]> {
  const { rows } = await execQuery(
    env,
    `SELECT cron_run_log_id, job_name, status, error, started_at, finished_at, duration_ms, detail
       FROM public.cron_run_log
      WHERE job_name = $1 AND started_at > now() - ($2 || ' days')::interval
      ORDER BY started_at DESC`,
    [jobName, sinceDays],
    'cron.runLog.recentForJob'
  );
  return rows;
}

/** Deletes cron_run_log rows older than `retainDays` (default 7) — the
 *  table has no retention otherwise and the frequent tier (every 15 min)
 *  alone writes ~96 rows/day forever. Run as its own daily job
 *  (pruneCronRunLog in JOB_REGISTRY), not folded into runJob() itself, so a
 *  slow prune can't delay every job's own finish-row write. */
export async function pruneOldCronRunLogs(env: Env, retainDays = 7): Promise<void> {
  await execQuery(
    env,
    `DELETE FROM public.cron_run_log WHERE started_at < now() - ($1 || ' days')::interval`,
    [retainDays],
    'cron.runLog.prune'
  );
}

/** Average duration of successful runs per job, last `sinceHours` — context for "is this run slow". */
export async function avgDurationPerJob(env: Env, sinceHours = 24): Promise<{ job_name: string; avg_ms: number; runs: number }[]> {
  const { rows } = await execQuery(
    env,
    `SELECT job_name, AVG(duration_ms)::int AS avg_ms, COUNT(*)::int AS runs
       FROM public.cron_run_log
      WHERE status = 'ok' AND started_at > now() - ($1 || ' hours')::interval
      GROUP BY job_name`,
    [sinceHours],
    'cron.runLog.avgDuration'
  );
  return rows;
}

// --- public.scheduled_job (migration 103) — which Cloudflare Cron Trigger
// tier (see wrangler.toml) each named job runs on. Editable from
// Settings > Scheduled Jobs; a change takes effect on that tier's next tick,
// no redeploy. Kept to a fixed tier set on purpose — see migration 103's
// header on why this isn't a free-text cron column. ---------------------

// 'off' is the stop switch (migration 107), not a tier: no cron maps to it,
// so jobsForTier() never names an 'off' job and it simply never runs. Jobs
// that can also be cancelled mid-run (backupStorage) re-read their own tier
// while running and bail when they see 'off' — see isJobPaused below.
export type RunnableCronTier = 'frequent' | 'hourly' | 'daily' | 'nightly';
export type CronTier = RunnableCronTier | 'off';

// Matches wrangler.toml's [triggers]/[env.production.triggers] crons exactly.
// 'nightly' fires every 20 min from 8am-1pm UTC (~1am-6am Pacific) — exclusively
// backupStorage's tier (see DEFAULT_TIER_JOBS), repeated on purpose: Cloudflare
// caps one invocation at ~1000 outgoing fetch() calls (one per object copied),
// so a backlog bigger than that can't clear in a single tick no matter how
// long its own time budget is — only more ticks get through more of it. ~15
// ticks across the window gives it that room; once the backlog's cleared,
// the extra ticks just find nothing pending and no-op. Cron Triggers have no
// timezone concept, so this reads an hour earlier once daylight saving ends
// (PST) — still inside the window, just not centered on it anymore.
export const TIER_CRON: Record<RunnableCronTier, string> = {
  frequent: '*/15 * * * *',
  hourly: '0 * * * *',
  daily: '0 6 * * *',
  nightly: '*/20 8-12 * * *',
};

const CRON_TIER: Record<string, RunnableCronTier> = Object.fromEntries(
  Object.entries(TIER_CRON).map(([tier, cron]) => [cron, tier as RunnableCronTier])
);

export function tierForCron(cron: string): RunnableCronTier | null {
  return CRON_TIER[cron] ?? null;
}

// Fallback if public.scheduled_job is missing a row (or the table itself,
// pre-migration) — today's hardcoded assignment, so a missing row degrades
// to current behavior rather than silently dropping a job from every tier.
const DEFAULT_TIER_JOBS: Record<RunnableCronTier, string[]> = {
  frequent: ['checkQbwcStale', 'runScheduledNotifications'],
  hourly: ['backfillDocumentIndex'],
  daily: ['lockStaleReps', 'pruneCronRunLog'],
  nightly: ['backupStorage'],
};

/** Job names assigned to run on this tier, per public.scheduled_job.
 *
 *  Reads the whole table rather than filtering in SQL on purpose: a tier with
 *  no rows has to be told apart from a table with no rows at all. Only the
 *  latter falls back to DEFAULT_TIER_JOBS (the pre-migration-103 safety net) —
 *  an empty result for one tier is a real answer, "nothing runs here", which
 *  is exactly what parking every job on 'off' (migration 107) produces. Doing
 *  it the other way round made the stop switch a no-op: moving the only
 *  nightly job to 'off' emptied that tier, and the fallback re-added it. */
export async function jobsForTier(env: Env, tier: RunnableCronTier): Promise<string[]> {
  try {
    const { rows } = await execQuery(
      env,
      `SELECT job_name, cron_tier FROM public.scheduled_job`,
      [],
      'cron.scheduledJob.byTier'
    );
    if (rows.length === 0) return DEFAULT_TIER_JOBS[tier] ?? [];
    return rows
      .filter((r: { cron_tier: string }) => r.cron_tier === tier)
      .map((r: { job_name: string }) => r.job_name);
  } catch (e) {
    console.error(`[cron] scheduled_job lookup failed for tier ${tier}, using built-in default:`, e instanceof Error ? e.message : e);
    return DEFAULT_TIER_JOBS[tier] ?? [];
  }
}

/** Writes one already-finished row directly — for work the BROWSER drives
 *  (Settings > Backup's storage export/restore loop, one HTTP call per
 *  object) and reports its own outcome once the loop ends, unlike runJob()
 *  which times a Worker-side async function itself. No 'running' row: the
 *  Worker never sees the work in progress, only the summary after. */
export async function logCompletedRun(
  env: Env,
  jobName: string,
  status: 'ok' | 'error',
  detail?: Record<string, unknown> | null,
  durationMs?: number | null,
  error?: string | null
): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO public.cron_run_log (job_name, status, finished_at, duration_ms, detail, error)
     VALUES ($1, $2, now(), $3, $4, $5)`,
    [jobName, status, durationMs ?? null, detail ?? null, error ?? null],
    'cron.runLog.logCompleted'
  );
}

export interface ScheduledJobRow {
  scheduled_job_id: number;
  job_name: string;
  cron_tier: CronTier;
  updated_at: string;
}

/** Every known job's current tier — Settings > Scheduled Jobs' edit panel. */
export async function listScheduledJobs(env: Env): Promise<ScheduledJobRow[]> {
  const { rows } = await execQuery(
    env,
    `SELECT scheduled_job_id, job_name, cron_tier, updated_at FROM public.scheduled_job ORDER BY job_name`,
    [],
    'cron.scheduledJob.list'
  );
  return rows;
}

/** One job's current tier, or null if it has no scheduled_job row. */
export async function jobTier(env: Env, jobName: string): Promise<CronTier | null> {
  const { rows } = await execQuery(
    env,
    `SELECT cron_tier FROM public.scheduled_job WHERE job_name = $1`,
    [jobName],
    'cron.scheduledJob.tier'
  );
  return rows[0]?.cron_tier ?? null;
}

/** True when this job is parked on the 'off' tier (migration 107) — i.e. the
 *  user has stopped it. Read both before a run starts and periodically during
 *  a long run (storageBackup.ts), so the switch also cancels work already in
 *  flight, not just future ticks.
 *
 *  Fails open: a lookup error answers "not paused", so a database hiccup
 *  can't silently stop a backup. The job's own error handling covers the case
 *  where the database is genuinely unreachable. */
export async function isJobPaused(env: Env, jobName: string): Promise<boolean> {
  try {
    return (await jobTier(env, jobName)) === 'off';
  } catch (e) {
    console.error(`[cron] pause check failed for ${jobName}, treating as not paused:`, e instanceof Error ? e.message : e);
    return false;
  }
}

export async function setJobTier(env: Env, jobName: string, tier: CronTier): Promise<ScheduledJobRow | null> {
  const { rows } = await execQuery(
    env,
    `UPDATE public.scheduled_job SET cron_tier = $2, updated_at = now() WHERE job_name = $1
     RETURNING scheduled_job_id, job_name, cron_tier, updated_at`,
    [jobName, tier],
    'cron.scheduledJob.setTier'
  );
  return rows[0] ?? null;
}
