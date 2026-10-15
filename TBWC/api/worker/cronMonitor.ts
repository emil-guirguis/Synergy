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

export async function runJob(env: Env, jobName: string, fn: () => Promise<void>): Promise<void> {
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
    await fn();
    if (logId != null) {
      await execQuery(
        env,
        `UPDATE public.cron_run_log SET status = 'ok', finished_at = now(), duration_ms = $2 WHERE cron_run_log_id = $1`,
        [logId, Date.now() - startedAt],
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
}

/** Most recent row per job_name — the dashboard's "last run" tiles. */
export async function latestRunPerJob(env: Env): Promise<CronRunRow[]> {
  const { rows } = await execQuery(
    env,
    `SELECT DISTINCT ON (job_name) cron_run_log_id, job_name, status, error, started_at, finished_at, duration_ms
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
    `SELECT cron_run_log_id, job_name, status, error, started_at, finished_at, duration_ms
       FROM public.cron_run_log
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit],
    'cron.runLog.recent'
  );
  return rows;
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

// --- public.scheduled_job (migration 103) — which of the 3 Cloudflare Cron
// Trigger tiers (see wrangler.toml) each named job runs on. Editable from
// Settings > Scheduled Jobs; a change takes effect on that tier's next tick,
// no redeploy. Kept to 3 fixed tiers on purpose — see migration 103's header
// on why this isn't a free-text cron column. ---------------------------

export type CronTier = 'frequent' | 'hourly' | 'daily';

// Matches wrangler.toml's [triggers]/[env.production.triggers] crons exactly.
export const TIER_CRON: Record<CronTier, string> = {
  frequent: '*/15 * * * *',
  hourly: '0 * * * *',
  daily: '0 6 * * *',
};

const CRON_TIER: Record<string, CronTier> = Object.fromEntries(
  Object.entries(TIER_CRON).map(([tier, cron]) => [cron, tier as CronTier])
);

export function tierForCron(cron: string): CronTier | null {
  return CRON_TIER[cron] ?? null;
}

// Fallback if public.scheduled_job is missing a row (or the table itself,
// pre-migration) — today's hardcoded assignment, so a missing row degrades
// to current behavior rather than silently dropping a job from every tier.
const DEFAULT_TIER_JOBS: Record<CronTier, string[]> = {
  frequent: ['checkQbwcStale', 'runScheduledNotifications'],
  hourly: ['backfillDocumentIndex'],
  daily: ['lockStaleReps'],
};

/** Job names assigned to run on this tier, per public.scheduled_job. */
export async function jobsForTier(env: Env, tier: CronTier): Promise<string[]> {
  try {
    const { rows } = await execQuery(
      env,
      `SELECT job_name FROM public.scheduled_job WHERE cron_tier = $1`,
      [tier],
      'cron.scheduledJob.byTier'
    );
    if (rows.length === 0) return DEFAULT_TIER_JOBS[tier] ?? [];
    return rows.map((r: { job_name: string }) => r.job_name);
  } catch (e) {
    console.error(`[cron] scheduled_job lookup failed for tier ${tier}, using built-in default:`, e instanceof Error ? e.message : e);
    return DEFAULT_TIER_JOBS[tier] ?? [];
  }
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
