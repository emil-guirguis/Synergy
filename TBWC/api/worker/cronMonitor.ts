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
