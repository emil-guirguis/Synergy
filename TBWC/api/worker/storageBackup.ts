/**
 * Mirrors Supabase Storage bucket objects (file bytes) into a second bucket
 * ('storage-backup', migration 109) in this same Supabase project. Born from
 * confirming Supabase's own daily physical backups cover Postgres only —
 * storage.objects rows (metadata) are in that dump, the actual bytes in
 * record-docs/rep-docs/item-images are not backed up anywhere. A second
 * bucket is still an independent copy (separate RLS, survives the same
 * "bytes missing from one bucket" failure this was built for) — it was R2
 * originally, moved here (migration 109) since R2 needs enabling through
 * the Cloudflare dashboard before any deploy, and this reuses the
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY already configured, no new secret.
 *
 * Runs incrementally, one bounded batch per invocation (see worker/index.ts's
 * scheduled() -> JOB_REGISTRY.backupStorage, tier 'nightly' per migration
 * 106; parking it on 'off' stops it, see setBackupPaused): each call does
 * at most BATCH_SIZE objects, so a fresh ~13GB/11.4k-object backlog
 * (record-docs today) trickles in over many ticks rather than one shot — the
 * Worker's per-invocation subrequest cap (1000 on a paid plan; every object
 * here costs one Supabase Storage object/copy call — see copyToBackupBucket,
 * no file bytes transit the Worker) makes a single-pass sweep of that many
 * objects impossible anyway. public.storage_backup_object
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

export const BACKUP_BUCKETS = ['record-docs', 'rep-docs', 'item-images'] as const;
export type BackupBucket = (typeof BACKUP_BUCKETS)[number];

/** The Supabase Storage bucket holding the mirror itself (migration 109) —
 *  distinct from BACKUP_BUCKETS, the source buckets being mirrored. Each
 *  object is stored under `${sourceBucket}/${path}` so one backup bucket can
 *  hold all three sources without name collisions. */
const BACKUP_BUCKET = 'storage-backup';

// Every object costs one object/copy call to Supabase, which counts against
// the Worker's per-invocation subrequest cap (1000 on a paid plan) — no file
// bytes involved, so this is a request-count cap, not a bandwidth one. Kept
// well under that cap per bucket per tick, with room for the odd retry,
// rather than tuned to the exact limit.
const BATCH_SIZE = 300;

function requireSupabaseEnv(env: Env): { url: string; key: string } {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service role key not configured');
  }
  return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY };
}

/** Mirrors one object into the backup bucket via Supabase Storage's
 *  server-side object/copy — same call restoreObjectFromBackup already uses
 *  for the reverse direction. This replaced a download-then-reupload
 *  (fetchDocumentBytes + a raw body POST) that round-tripped every file's
 *  full bytes through the Worker for a copy that's same-project on both
 *  ends: that cost ~1.8s/object even for small files and meant one 25s tick
 *  cleared only ~25 objects. The leftover was inherited from when this
 *  mirrored into an R2 bucket (migration 109's predecessor) — cross-provider,
 *  so download+reupload was the only option there; moving the destination
 *  into the same Supabase project (109) made a server-side copy possible,
 *  but only restoreObjectFromBackup was written to use it at the time. */
/** True if the destination object exists with real, matching bytes. Uses a
 *  ranged GET, not HEAD — this project's Storage API has a known history of
 *  HEAD returning 200 for objects with no real bytes behind them (the same
 *  ghost-object class as the quote-doc-bytes audit), so HEAD can't be
 *  trusted here. expectedSize is only checked when known (the 409 retry path
 *  below doesn't have one). */
async function destinationLooksReal(env: Env, destinationKey: string, expectedSize: string | null): Promise<boolean> {
  const { url, key } = requireSupabaseEnv(env);
  const res = await fetch(`${url}/storage/v1/object/${BACKUP_BUCKET}/${destinationKey.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${key}`, apikey: key, Range: 'bytes=0-0' },
  });
  if (res.status !== 206) return false;
  if (expectedSize == null) return true;
  const total = res.headers.get('content-range')?.split('/')[1];
  return total != null && Number(total) === Number(expectedSize);
}

async function copyToBackupBucket(
  env: Env,
  sourceBucket: string,
  path: string,
  expectedSize: string | null
): Promise<void> {
  const { url, key } = requireSupabaseEnv(env);
  const destinationKey = `${sourceBucket}/${path}`;
  const res = await fetch(`${url}/storage/v1/object/copy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketId: sourceBucket,
      sourceKey: path,
      destinationBucket: BACKUP_BUCKET,
      destinationKey,
    }),
  });
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    // object/copy has no upsert — if an earlier attempt's copy actually
    // landed but the ledger write after it never happened (worker killed
    // between the two, or two overlapping runs racing the same object), the
    // retry 409s forever with nothing to tell it the object's already there.
    // That's the exact shape of bug this project's hit before (ledger/mirror
    // disagreeing — see the quote-doc-bytes audit): confirm with a real byte
    // read rather than leaving it permanently stuck pending.
    let code: string | undefined;
    try { code = JSON.parse(bodyText)?.code; } catch { /* not JSON, not this case */ }
    if (code === 'KeyAlreadyExists' && (await destinationLooksReal(env, destinationKey, expectedSize))) return;
    throw new Error(`Supabase backup copy failed: ${res.status} ${bodyText}`);
  }
  // A 200 here isn't proof the mirror object actually stuck — same ghost-
  // object risk as above. Checking the copy response's own reported size
  // against what we queried from storage.objects catches a bogus/short
  // write at the moment it happens, instead of only on the next integrity
  // audit — a mismatch (or unparseable body) is treated as a failed copy,
  // same as a non-2xx, so the ledger is never written and the object stays
  // pending for retry.
  let reportedSize: number | undefined;
  try {
    reportedSize = JSON.parse(bodyText)?.metadata?.size;
  } catch {
    throw new Error(`Supabase backup copy returned an unparseable body: ${bodyText.slice(0, 200)}`);
  }
  // expectedSize comes from a Postgres bigint column, which node-postgres
  // returns as a string (not a number) to avoid silent precision loss — a
  // strict !== here compared that string against reportedSize's JSON number
  // and rejected every single copy as a false mismatch. Number() on both
  // sides is safe: document sizes are nowhere near Number.MAX_SAFE_INTEGER.
  if (expectedSize != null && Number(reportedSize) !== Number(expectedSize)) {
    throw new Error(`Supabase backup copy size mismatch for ${sourceBucket}/${path}: expected ${expectedSize}, got ${reportedSize}`);
  }
}

/** The job_name this module runs under in public.scheduled_job (103) and
 *  cron_run_log (102) — also the row the pause switch flips. */
export const BACKUP_JOB_NAME = 'backupStorage';

/** Tier the Resume button puts the job back on — migration 106's default. */
export const BACKUP_DEFAULT_TIER: CronTier = 'nightly';

/** Objects are copied CONCURRENCY at a time (Promise.all per chunk), not one
 *  at a time: copyToBackupBucket is a single small Supabase API call with no
 *  file bytes in it (object/copy is server-side), so its cost is almost
 *  entirely network round-trip latency, not CPU — one serial copy measured
 *  ~1.8s (including the old download+reupload this replaced); 25 concurrent
 *  copies measured ~300 objects in ~12s, a ~25x wall-clock improvement for
 *  the same work. Also the cadence for re-reading the pause switch (migration
 *  107) and the elapsed-time check below: between chunks, not between every
 *  object (that would serialize the very thing concurrency just fixed) and
 *  not once per tick (a tick can cover BATCH_SIZE objects — too coarse for
 *  either check to bite in time). */
const CONCURRENCY = 25;

/** Wall-clock budget for one backupStorageToSupabase call, across all 3 buckets.
 *  Unlike aiSearch.ts's backfillDocumentIndex, this job had no self-imposed
 *  deadline at all — only BATCH_SIZE (a request-count cap, not a time cap)
 *  stood between it and the Worker's own execution-duration limit. A
 *  backlog big enough to run long gets the invocation killed mid-batch,
 *  before runJob()'s finish UPDATE — the same stuck-'running'-forever
 *  signature as the old backfillDocumentIndex bug (cronMonitor.ts's
 *  healStaleRunningRows now also catches this generically). Bailing out
 *  early (same as a user-requested stop: whatever's copied stays copied,
 *  ledger picks up next tick) keeps the finish write reachable regardless of
 *  backlog size.
 *
 *  Sized to clear BATCH_SIZE*3 (900) objects — the real ceiling per
 *  invocation is Cloudflare's ~1000-subrequest cap, not this budget — with
 *  margin: 900 objects at the measured concurrent-copy rate takes ~35s, so
 *  60s leaves room for a slower night without being the thing that cuts a
 *  tick short before the subrequest cap does. */
const MAX_TICK_MILLIS = 60_000;

interface PendingObject {
  name: string;
  // node-postgres returns bigint columns as strings, not numbers.
  size: string | null;
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

async function markBackedUp(env: Env, bucket: string, path: string, bytes: string | null): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO public.storage_backup_object (bucket, storage_path, bytes)
     VALUES ($1, $2, $3)
     ON CONFLICT (bucket, storage_path) DO UPDATE SET bytes = $3, backed_up_at = now()`,
    [bucket, path, bytes],
    'storageBackup.markBackedUp'
  );
}

async function backupBucket(
  env: Env,
  bucket: string,
  deadline: number
): Promise<{ copied: number; failed: number; cancelled: boolean }> {
  let copied = 0;
  let failed = 0;
  let firstChunk = true;
  let budgetSpent = false;
  // Re-pages BATCH_SIZE at a time instead of fetching once: once the smaller
  // buckets (rep-docs, item-images) are caught up, every tick's pending set
  // is just whichever bucket still has a backlog (record-docs today) — a
  // single BATCH_SIZE page of that bucket took ~11s to copy, so stopping
  // after one page left ~49s of a 60s budget (and most of the 1000-subrequest
  // cap) unused every single tick. Looping here lets one tick drain several
  // pages of the same bucket, bounded by the real ceiling (deadline, or the
  // pause switch) rather than an arbitrary one-page-per-tick cap.
  while (true) {
    if (!firstChunk && Date.now() >= deadline) return { copied, failed, cancelled: true };
    const pending = await pendingObjects(env, bucket, BATCH_SIZE);
    if (pending.length === 0) return { copied, failed, cancelled: false };
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      // Mid-run stop (migration 107) and the wall-clock budget (MAX_TICK_MILLIS)
      // share this cadence: checked between chunks, not before the first one
      // (a stop requested before this call even started is the pre-run guard's
      // job, in backupStorageToSupabase). Everything already copied stays
      // copied — the ledger row per object is written as its chunk finishes,
      // so stopping early (paused or out of time) is just a short run, and the
      // next tick picks up exactly where this one stopped.
      if (!firstChunk) {
        if (Date.now() >= deadline) return { copied, failed, cancelled: true };
        if (await isJobPaused(env, BACKUP_JOB_NAME)) return { copied, failed, cancelled: true };
      }
      firstChunk = false;
      const chunk = pending.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (obj) => {
          try {
            await copyToBackupBucket(env, bucket, obj.name, obj.size);
            await markBackedUp(env, bucket, obj.name, obj.size);
            return true;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Running out of Cloudflare subrequests means this invocation is
            // spent, not that the object is bad. Counting it as a failure was
            // actively harmful: the object stayed unmarked, the loop below
            // re-queried the very same pending rows, failed them again, and
            // burned the whole 60s tick — the `copied: 0, failed: 3125` runs.
            if (msg.includes('Too many subrequests')) {
              budgetSpent = true;
              return null;
            }
            console.error(`[storageBackup] copy failed, leaving for next tick: ${bucket}/${obj.name}:`, msg);
            return false;
          }
        })
      );
      copied += results.filter((r) => r === true).length;
      failed += results.filter((r) => r === false).length;
      // Everything copied so far is already marked, so stopping here simply
      // makes this a short tick; the next one resumes from the ledger.
      if (budgetSpent) return { copied, failed, cancelled: true };
    }
    // A short page means this bucket's actually exhausted, not just paused
    // between pages — no point re-querying it again this tick.
    if (pending.length < BATCH_SIZE) return { copied, failed, cancelled: false };
  }
}

// A type alias, not an interface: runJob() takes fn: () => Promise<Record<
// string, unknown> | void>, and only a type literal (not a named interface)
// is structurally assignable to an indexed type like Record<string, unknown>.
export type StorageBackupRunDetail = {
  copied: number;
  failed: number;
  /** True if a bucket bailed on the time budget or the pause switch, leaving
   *  buckets after it untouched this tick — not a failure, just unfinished. */
  stopped: boolean;
};

export async function backupStorageToSupabase(env: Env): Promise<StorageBackupRunDetail> {
  // Belt and braces with scheduled()'s own tier filter: a paused job isn't
  // named by jobsForTier() at all, but this also covers the manual
  // "back up now" path and a tick that was already dispatched when the
  // switch was flipped.
  if (await isJobPaused(env, BACKUP_JOB_NAME)) {
    console.log('[storageBackup] paused — nothing copied');
    return { copied: 0, failed: 0, stopped: true };
  }
  const deadline = Date.now() + MAX_TICK_MILLIS;
  const results: string[] = [];
  let totalCopied = 0;
  let totalFailed = 0;
  for (const bucket of BACKUP_BUCKETS) {
    const { copied, failed, cancelled } = await backupBucket(env, bucket, deadline);
    totalCopied += copied;
    totalFailed += failed;
    results.push(`${bucket}: ${copied} copied${failed ? `, ${failed} failed` : ''}${cancelled ? ', stopped' : ''}`);
    // Deliberately not thrown: a user-requested stop (or running out of this
    // tick's time budget) is not a job failure, so cron_run_log (via runJob)
    // keeps recording the run as 'ok' — a short one.
    if (cancelled) {
      console.log(`[storageBackup] stopped mid-run, remaining buckets skipped | ${results.join(' | ')}`);
      return { copied: totalCopied, failed: totalFailed, stopped: true };
    }
  }
  console.log(`[storageBackup] ${results.join(' | ')}`);
  return { copied: totalCopied, failed: totalFailed, stopped: false };
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

/** Restores one object from the backup bucket back into live Supabase
 *  Storage, overwriting whatever (if anything) is there now — for
 *  recovering a deleted or corrupted file. Admin-triggered only; never run
 *  automatically. A same-project copy — Supabase's own object/copy API does
 *  it server-side in one call, no bytes round-tripping through the Worker
 *  (unlike the old R2 version, which had to download then re-upload). */
export async function restoreObjectFromBackup(env: Env, bucket: string, path: string): Promise<void> {
  const { url, key } = requireSupabaseEnv(env);
  const res = await fetch(`${url}/storage/v1/object/copy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketId: BACKUP_BUCKET,
      sourceKey: `${bucket}/${path}`,
      destinationBucket: bucket,
      destinationKey: path,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404) throw new Error(`${bucket}/${path} not found in backup`);
    throw new Error(`Supabase restore copy failed: ${res.status} ${body}`);
  }
}

export interface RestoreBatchResult {
  restored: number;
  failed: number;
  /** Pass back as `cursor` on the next call to continue; null means done. */
  cursor: string | null;
}

/** Restores one bounded page of a whole bucket's backed-up objects back into
 *  live Supabase Storage (unconditional overwrite — restoring an object
 *  already current in Supabase is a harmless no-op) — call repeatedly with
 *  the returned `cursor` (the Settings panel drives this loop itself) until
 *  it comes back null. Keyset-paged on name (not offset) so a restore
 *  already in progress isn't thrown off by rows the backup job adds
 *  mid-restore. Queries storage.objects directly (same project, so this is
 *  just SQL) rather than Supabase Storage's list API, which paginates by
 *  folder level, not a flat prefix the way R2's list() did. */
export async function restoreBucketBatch(env: Env, bucket: string, cursor?: string | null): Promise<RestoreBatchResult> {
  const { rows } = await execQuery(
    env,
    `SELECT name FROM storage.objects
      WHERE bucket_id = $1 AND name LIKE $2 AND name > $3
      ORDER BY name
      LIMIT $4`,
    [BACKUP_BUCKET, `${bucket}/%`, cursor ? `${bucket}/${cursor}` : '', BATCH_SIZE],
    'storageBackup.restoreBatch.list'
  );
  let restored = 0;
  let failed = 0;
  let lastPath: string | null = null;
  for (const row of rows) {
    const path = row.name.slice(bucket.length + 1);
    try {
      await restoreObjectFromBackup(env, bucket, path);
      restored++;
    } catch (e) {
      failed++;
      console.error(`[storageBackup] restore failed for ${bucket}/${path}:`, e instanceof Error ? e.message : e);
    }
    lastPath = path;
  }
  return { restored, failed, cursor: rows.length === BATCH_SIZE ? lastPath : null };
}
