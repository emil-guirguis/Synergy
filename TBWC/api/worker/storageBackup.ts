/**
 * Mirrors Supabase Storage bucket objects (file bytes) into the R2 bucket
 * bound as env.STORAGE_BACKUP. Born from confirming Supabase's own daily
 * physical backups cover Postgres only — storage.objects rows (metadata)
 * are in that dump, the actual bytes in record-docs/rep-docs/item-images
 * are not backed up anywhere.
 *
 * Runs incrementally, one bounded batch per invocation (see worker/index.ts's
 * scheduled() -> JOB_REGISTRY.backupStorage, tier 'nightly' per migration
 * 106; parking it on 'off' stops it, see setBackupPaused): each call does
 * at most BATCH_SIZE objects, so a fresh ~13GB/11.4k-object backlog
 * (record-docs today) trickles in over many ticks rather than one shot —
 * the Worker's per-invocation subrequest cap (fetch() to Supabase Storage;
 * the R2 binding's own calls don't count against it) makes a single-pass
 * sweep of that many objects impossible anyway. public.storage_backup_object
 * (migration 105) is the resumability ledger: each tick anti-joins
 * storage.objects against it to find what's still missing, so progress
 * survives restarts/redeploys with no separate cursor to track.
 *
 * Run history (ok/error/duration) for the job itself is NOT tracked here —
 * worker/index.ts wraps this in cronMonitor.ts's runJob(), which already
 * writes to cron_run_log keyed by job_name 'backupStorage'.
 *
 * None of this needs a browser: the copying happens in the Worker on a
 * Cloudflare Cron Trigger, so it runs with the portal closed. (Whole-bucket
 * RESTORE is the opposite — restoreBucketBatch is driven in a loop by the
 * Settings panel and stops if that tab goes away.)
 */
import { Env, execQuery } from './db';
import { isJobPaused, setJobTier, jobTier, type CronTier } from './cronMonitor';
import { fetchDocumentBytes } from '@meterit/framework-backend/api/base/aiSearch';

export const BACKUP_BUCKETS = ['record-docs', 'rep-docs', 'item-images'] as const;
export type BackupBucket = (typeof BACKUP_BUCKETS)[number];

// Only env.SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY-based fetch() calls count
// against the Worker's per-invocation subrequest cap (1000 on a paid plan);
// R2 binding calls don't. Kept well under that cap per bucket per tick, with
// room for the odd retry, rather than tuned to the exact limit.
const BATCH_SIZE = 300;

/** The job_name this module runs under in public.scheduled_job (103) and
 *  cron_run_log (102) — also the row the pause switch flips. */
export const BACKUP_JOB_NAME = 'backupStorage';

/** Tier the Resume button puts the job back on — migration 106's default. */
export const BACKUP_DEFAULT_TIER: CronTier = 'nightly';

/** How often a running backup re-reads its own pause state: every Nth object,
 *  not every object (that would double this job's query count for a switch
 *  that is almost never flipped) and not once per tick (a tick copies up to
 *  BATCH_SIZE objects per bucket, so "stop" would take minutes to be felt). */
const CANCEL_CHECK_EVERY = 25;

function r2Key(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

interface PendingObject {
  name: string;
  size: number | null;
}

async function pendingObjects(env: Env, bucket: string, limit: number): Promise<PendingObject[]> {
  const { rows } = await execQuery(
    env,
    `SELECT o.name, (o.metadata->>'size')::bigint AS size
       FROM storage.objects o
      WHERE o.bucket_id = $1
        AND o.is_delete_marker = false
        AND o.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.storage_backup_object b
           WHERE b.bucket = $1 AND b.storage_path = o.name
        )
      ORDER BY o.created_at
      LIMIT $2`,
    [bucket, limit],
    'storageBackup.pending'
  );
  return rows;
}

async function markBackedUp(env: Env, bucket: string, path: string, bytes: number | null): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO public.storage_backup_object (bucket, storage_path, bytes)
     VALUES ($1, $2, $3)
     ON CONFLICT (bucket, storage_path) DO UPDATE SET bytes = $3, backed_up_at = now()`,
    [bucket, path, bytes],
    'storageBackup.markBackedUp'
  );
}

async function backupBucket(env: Env, bucket: string): Promise<{ copied: number; failed: number; cancelled: boolean }> {
  const pending = await pendingObjects(env, bucket, BATCH_SIZE);
  let copied = 0;
  let failed = 0;
  let processed = 0;
  for (const obj of pending) {
    // Mid-run stop (migration 107): checked between objects, so the switch
    // takes effect within ~CANCEL_CHECK_EVERY objects instead of waiting for
    // the whole batch. Everything already copied stays copied — the ledger
    // row per object is written as we go, so a cancelled run is just a short
    // one and the next run picks up exactly where this one stopped.
    if (processed > 0 && processed % CANCEL_CHECK_EVERY === 0 && (await isJobPaused(env, BACKUP_JOB_NAME))) {
      return { copied, failed, cancelled: true };
    }
    processed++;
    const bytes = await fetchDocumentBytes(env, bucket, obj.name);
    if (bytes === null) {
      failed++;
      console.error(`[storageBackup] fetch failed, leaving for next tick: ${bucket}/${obj.name}`);
      continue;
    }
    await env.STORAGE_BACKUP.put(r2Key(bucket, obj.name), bytes);
    await markBackedUp(env, bucket, obj.name, obj.size ?? bytes.byteLength);
    copied++;
  }
  return { copied, failed, cancelled: false };
}

export async function backupStorageToR2(env: Env): Promise<void> {
  if (!env.STORAGE_BACKUP) throw new Error('STORAGE_BACKUP R2 binding not configured');
  // Belt and braces with scheduled()'s own tier filter: a paused job isn't
  // named by jobsForTier() at all, but this also covers the manual
  // "back up now" path and a tick that was already dispatched when the
  // switch was flipped.
  if (await isJobPaused(env, BACKUP_JOB_NAME)) {
    console.log('[storageBackup] paused — nothing copied');
    return;
  }
  const results: string[] = [];
  for (const bucket of BACKUP_BUCKETS) {
    const { copied, failed, cancelled } = await backupBucket(env, bucket);
    results.push(`${bucket}: ${copied} copied${failed ? `, ${failed} failed` : ''}${cancelled ? ', stopped' : ''}`);
    // Deliberately not thrown: a user-requested stop is not a job failure, so
    // cron_run_log (via runJob) keeps recording the run as 'ok' — a short one.
    if (cancelled) {
      console.log(`[storageBackup] paused mid-run, remaining buckets skipped | ${results.join(' | ')}`);
      return;
    }
  }
  console.log(`[storageBackup] ${results.join(' | ')}`);
}

export interface BackupPauseState {
  paused: boolean;
  tier: CronTier | null;
}

/** Is the backup job stopped right now — Settings > Storage Backup's
 *  Pause/Resume button state. */
export async function backupPauseState(env: Env): Promise<BackupPauseState> {
  const tier = await jobTier(env, BACKUP_JOB_NAME);
  return { paused: tier === 'off', tier };
}

/** The stop/start button itself. Parking the job on 'off' both keeps future
 *  cron ticks from running it and cancels a run already in progress (see
 *  backupBucket); resuming puts it back on BACKUP_DEFAULT_TIER, since the
 *  previous tier isn't recorded anywhere. */
export async function setBackupPaused(env: Env, paused: boolean): Promise<BackupPauseState> {
  const updated = await setJobTier(env, BACKUP_JOB_NAME, paused ? 'off' : BACKUP_DEFAULT_TIER);
  if (!updated) throw new Error(`No scheduled_job row for "${BACKUP_JOB_NAME}"`);
  return { paused: updated.cron_tier === 'off', tier: updated.cron_tier };
}

export interface BucketBackupStatus {
  bucket: string;
  total: number;
  backedUp: number;
  pending: number;
}

/** Settings > Storage Backup's progress tiles — total live objects per
 *  bucket vs. how many are already mirrored. */
export async function storageBackupStatus(env: Env): Promise<BucketBackupStatus[]> {
  const { rows } = await execQuery(
    env,
    `SELECT o.bucket_id AS bucket,
            count(*)::int AS total,
            count(b.storage_backup_object_id)::int AS backed_up
       FROM storage.objects o
       LEFT JOIN public.storage_backup_object b
         ON b.bucket = o.bucket_id AND b.storage_path = o.name
      WHERE o.bucket_id = ANY($1) AND o.is_delete_marker = false AND o.archived_at IS NULL
      GROUP BY o.bucket_id`,
    [BACKUP_BUCKETS as unknown as string[]],
    'storageBackup.status'
  );
  const byBucket = new Map(rows.map((r: any) => [r.bucket, r]));
  return BACKUP_BUCKETS.map((bucket) => {
    const r = byBucket.get(bucket);
    const total = r?.total ?? 0;
    const backedUp = r?.backed_up ?? 0;
    return { bucket, total, backedUp, pending: total - backedUp };
  });
}

/** Restores one object from the R2 mirror back into live Supabase Storage,
 *  overwriting whatever (if anything) is there now — for recovering a
 *  deleted or corrupted file. Admin-triggered only; never run automatically. */
export async function restoreObjectFromR2(env: Env, bucket: string, path: string): Promise<void> {
  if (!env.STORAGE_BACKUP) throw new Error('STORAGE_BACKUP R2 binding not configured');
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase service role key not configured');
  const obj = await env.STORAGE_BACKUP.get(r2Key(bucket, path));
  if (!obj) throw new Error(`${bucket}/${path} not found in backup`);
  const bytes = await obj.arrayBuffer();
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Supabase upload failed: ${res.status} ${await res.text().catch(() => '')}`);
}

export interface RestoreBatchResult {
  restored: number;
  failed: number;
  /** Pass back as `cursor` on the next call to continue; null means done. */
  cursor: string | null;
}

/** Restores one bounded page of a whole bucket's R2-mirrored objects back
 *  into live Supabase Storage (unconditional overwrite — restoring an
 *  object already current in Supabase is a harmless no-op), unconditionally
 *  — call repeatedly with the returned `cursor` (the Settings panel drives
 *  this loop itself) until it comes back null. Cursor-paged rather than
 *  always listing from the start, or every call would just re-restore the
 *  same first BATCH_SIZE objects forever. */
export async function restoreBucketBatch(env: Env, bucket: string, cursor?: string | null): Promise<RestoreBatchResult> {
  if (!env.STORAGE_BACKUP) throw new Error('STORAGE_BACKUP R2 binding not configured');
  const listed = await env.STORAGE_BACKUP.list({ prefix: `${bucket}/`, limit: BATCH_SIZE, cursor: cursor ?? undefined });
  let restored = 0;
  let failed = 0;
  for (const key of listed.objects) {
    const path = key.name.slice(bucket.length + 1);
    try {
      await restoreObjectFromR2(env, bucket, path);
      restored++;
    } catch (e) {
      failed++;
      console.error(`[storageBackup] restore failed for ${bucket}/${path}:`, e instanceof Error ? e.message : e);
    }
  }
  return { restored, failed, cursor: listed.truncated ? listed.cursor ?? null : null };
}
