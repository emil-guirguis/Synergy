/**
 * Every job scheduled() can run, keyed by the job_name public.scheduled_job
 * (migration 103) uses to say which tier it's on. Adding a new scheduled job
 * means adding it here AND seeding a row for it in a migration — nothing
 * runs unless scheduled_job also names it.
 *
 * Pulled out of worker/index.ts into its own module so routes/settings.ts
 * (a "run now" button per job — Settings > Scheduled Jobs) can look a job up
 * without importing index.ts itself, which already imports settings.ts and
 * would make it a cycle.
 */
import { Env, execQuery } from './db';
import { lockStaleReps } from './reverification';
import { runScheduledNotifications } from '@meterit/framework-backend/api/base/scheduledNotifications';
import { backfillDocumentIndex } from '@meterit/framework-backend/api/base/aiSearch';
import { checkQbwcStale } from './qbwc/staleAlert';
import { backupStorageToR2 } from './storageBackup';
import { pruneOldCronRunLogs } from './cronMonitor';

export const JOB_REGISTRY: Record<string, (env: Env, now: Date) => Promise<Record<string, unknown> | void>> = {
  checkQbwcStale: (env) => checkQbwcStale(env),
  runScheduledNotifications: (env, now) =>
    runScheduledNotifications(execQuery, env, now, { tenantColumn: null, notificationOptions: { tenantColumn: null } }),
  backfillDocumentIndex: (env) => backfillDocumentIndex(execQuery, env),
  lockStaleReps: (env) => lockStaleReps(env),
  backupStorage: (env) => backupStorageToR2(env),
  pruneCronRunLog: (env) => pruneOldCronRunLogs(env),
};
