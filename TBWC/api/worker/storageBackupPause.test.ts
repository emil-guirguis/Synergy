/**
 * The stop switch for the storage backup job (migration 107): parking
 * backupStorage on scheduled_job.cron_tier = 'off' has to do three things,
 * each of which was a real hole in the first cut:
 *   1. keep future cron ticks from running it (jobsForTier)
 *   2. make a run already in progress bail (backupBucket's periodic re-read)
 *   3. not resurrect the job via jobsForTier's pre-migration fallback, which
 *      fired on "tier has no rows" and so undid the stop entirely
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecQuery = vi.fn();
vi.mock('./db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import { jobsForTier, isJobPaused, TIER_CRON, tierForCron, runJob } from './cronMonitor';
import { backupStorageToSupabase, fullBackupBatch } from './storageBackup';

// copyToBackupBucket/restoreObjectFromBackup call the global fetch() directly
// (a Supabase Storage object/copy REST call — no file bytes, same project on
// both ends), not an R2 binding — stub it.
const mockFetch = vi.fn();
const ENV = { SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' } as any;

/** Routes each query by its logged label, so a handler doesn't depend on the
 *  order the module happens to issue them in. */
function respondByTag(handlers: Record<string, (params: any[]) => any>) {
  mockExecQuery.mockImplementation((_env: any, _sql: string, params: any[], tag: string) => {
    const h = handlers[tag];
    if (!h) throw new Error(`unexpected query tag: ${tag}`);
    return Promise.resolve(h(params));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("'off' is not a runnable tier", () => {
  it('has no cron of its own, so no Cron Trigger can ever select it', () => {
    expect(Object.keys(TIER_CRON)).not.toContain('off');
    expect(tierForCron('0 9 */2 * *')).toBe('nightly');
  });
});

describe('jobsForTier', () => {
  it("doesn't name a job parked on 'off'", async () => {
    respondByTag({
      'cron.scheduledJob.byTier': () => ({
        rows: [
          { job_name: 'backupStorage', cron_tier: 'off' },
          { job_name: 'pruneCronRunLog', cron_tier: 'daily' },
        ],
      }),
    });
    expect(await jobsForTier(ENV, 'nightly')).toEqual([]);
    expect(await jobsForTier(ENV, 'daily')).toEqual(['pruneCronRunLog']);
  });

  it('does not fall back to the built-in defaults when a tier is legitimately empty', async () => {
    // The bug this guards: with backupStorage moved to 'off', the nightly tier
    // has no rows — and the old "rows.length === 0 -> defaults" branch handed
    // back ['backupStorage'], so the stopped job ran anyway on every tick.
    respondByTag({
      'cron.scheduledJob.byTier': () => ({ rows: [{ job_name: 'backupStorage', cron_tier: 'off' }] }),
    });
    expect(await jobsForTier(ENV, 'nightly')).not.toContain('backupStorage');
  });

  it('still falls back when the table itself is empty (pre-migration safety net)', async () => {
    respondByTag({ 'cron.scheduledJob.byTier': () => ({ rows: [] }) });
    expect(await jobsForTier(ENV, 'nightly')).toEqual(['backupStorage']);
  });

  it('falls back when the lookup fails outright', async () => {
    mockExecQuery.mockRejectedValue(new Error('connection refused'));
    expect(await jobsForTier(ENV, 'daily')).toEqual(['lockStaleReps', 'pruneCronRunLog']);
  });
});

describe('isJobPaused', () => {
  it('is true only for the off tier', async () => {
    respondByTag({ 'cron.scheduledJob.tier': () => ({ rows: [{ cron_tier: 'off' }] }) });
    expect(await isJobPaused(ENV, 'backupStorage')).toBe(true);

    respondByTag({ 'cron.scheduledJob.tier': () => ({ rows: [{ cron_tier: 'nightly' }] }) });
    expect(await isJobPaused(ENV, 'backupStorage')).toBe(false);
  });

  it('fails open, so a database hiccup never silently stops backups', async () => {
    mockExecQuery.mockRejectedValue(new Error('timeout'));
    expect(await isJobPaused(ENV, 'backupStorage')).toBe(false);
  });
});

describe('backupStorageToSupabase honours the switch', () => {
  it('copies nothing at all while paused', async () => {
    respondByTag({ 'cron.scheduledJob.tier': () => ({ rows: [{ cron_tier: 'off' }] }) });
    await backupStorageToSupabase(ENV);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stops mid-run when the switch is flipped, keeping what it already copied', async () => {
    // 100 pending objects in the first bucket; the switch flips to 'off' after
    // the run has started, so the periodic re-read (every 25 objects) catches
    // it instead of the whole 300-object batch running to completion.
    const pending = Array.from({ length: 100 }, (_, i) => ({ name: `doc-${i}.pdf`, size: 10 }));
    let tier = 'nightly';
    let tierReads = 0;
    respondByTag({
      'cron.scheduledJob.tier': () => {
        tierReads++;
        const answer = tier;
        // The first read is the pre-run guard and still sees 'nightly' — the
        // switch is flipped right after it, i.e. once the run is under way.
        if (tierReads === 1) tier = 'off';
        return { rows: [{ cron_tier: answer }] };
      },
      'storageBackup.pending': () => ({ rows: pending }),
      'storageBackup.markBackedUp': () => ({ rows: [] }),
    });

    await backupStorageToSupabase(ENV);

    // Stopped at the first mid-run check rather than copying all 100...
    expect(mockFetch).toHaveBeenCalledTimes(25);
    // ...and the remaining buckets were skipped, not swept.
    const buckets = new Set(mockFetch.mock.calls.map((c) => JSON.parse(c[1].body).bucketId));
    expect(buckets).toEqual(new Set(['record-docs']));
  });

  it('runs the full batch across every bucket when not paused', async () => {
    respondByTag({
      'cron.scheduledJob.tier': () => ({ rows: [{ cron_tier: 'nightly' }] }),
      'storageBackup.pending': (params) => ({
        rows: params[0] === 'record-docs' ? [{ name: 'a.pdf', size: 3 }] : [],
      }),
      'storageBackup.markBackedUp': () => ({ rows: [] }),
    });

    await backupStorageToSupabase(ENV);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://x.test/storage/v1/object/copy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bucketId: 'record-docs',
          sourceKey: 'a.pdf',
          destinationBucket: 'storage-backup',
          destinationKey: 'record-docs/a.pdf',
        }),
      })
    );
  });
});

/**
 * "Back up now" copies everything outstanding in one click, but it can't be
 * one request: Cloudflare caps an invocation at 1000 subrequests and every
 * object costs one Supabase copy call, so the panel re-POSTs /storage-backup/run
 * until a batch reports copying nothing. That loop's termination depends on two
 * contracts below — if either breaks, one click either stops after a single
 * batch (leaving the backlog) or spins forever on objects that can never copy.
 */
describe('the per-batch detail the one-click loop terminates on', () => {
  const okCopy = (size: number) => ({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ metadata: { size } })),
  });

  it('reports copied counts, so a batch that did work keeps the loop going', async () => {
    respondByTag({
      'cron.scheduledJob.tier': () => ({ rows: [{ cron_tier: 'nightly' }] }),
      'storageBackup.pending': (params) => ({
        rows: params[0] === 'rep-docs' ? [{ name: 'a.pdf', size: '3' }, { name: 'b.pdf', size: '4' }] : [],
      }),
      'storageBackup.markBackedUp': () => ({ rows: [] }),
    });
    mockFetch.mockImplementation((_u: string, init: any) =>
      Promise.resolve(okCopy(JSON.parse(init.body).sourceKey === 'a.pdf' ? 3 : 4))
    );

    expect(await backupStorageToSupabase(ENV)).toEqual({ copied: 2, failed: 0, stopped: false });
  });

  it('reports copied:0 with failures, so the loop stops instead of retrying forever', async () => {
    // Objects whose source bytes can't be copied stay pending on every tick.
    // Looping on "pending > 0" would spin on them until the tab closed —
    // copied === 0 is the floor the panel stops at.
    respondByTag({
      'cron.scheduledJob.tier': () => ({ rows: [{ cron_tier: 'nightly' }] }),
      'storageBackup.pending': (params) => ({
        rows: params[0] === 'record-docs' ? [{ name: 'broken.pdf', size: '9' }] : [],
      }),
      'storageBackup.markBackedUp': () => ({ rows: [] }),
    });
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });

    expect(await backupStorageToSupabase(ENV)).toEqual({ copied: 0, failed: 1, stopped: false });
  });

  it('hands the job\'s detail back through runJob, which the route returns to the client', async () => {
    // runJob used to return void and swallow the detail, so the route had
    // nothing to tell the client whether a batch made progress.
    respondByTag({
      'cron.runLog.healStale': () => ({ rows: [] }),
      'cron.runLog.start': () => ({ rows: [{ cron_run_log_id: 7 }] }),
      'cron.runLog.finishOk': () => ({ rows: [] }),
    });
    expect(await runJob(ENV, 'backupStorage', async () => ({ copied: 5, failed: 0, stopped: false })))
      .toEqual({ copied: 5, failed: 0, stopped: false });
  });

  it('returns undefined when the job throws, so the loop stops rather than hammering a broken job', async () => {
    respondByTag({
      'cron.runLog.healStale': () => ({ rows: [] }),
      'cron.runLog.start': () => ({ rows: [{ cron_run_log_id: 8 }] }),
      'cron.runLog.finishError': () => ({ rows: [] }),
    });
    expect(await runJob(ENV, 'backupStorage', async () => { throw new Error('db gone'); })).toBeUndefined();
  });
});

/**
 * "Back up now" is a FULL re-copy, not the incremental sweep the nightly job
 * runs: pressing it when the mirror is already complete must still copy every
 * file, because a manual backup that reports "nothing to do" is indistinguishable
 * from a broken button. fullBackupBatch is the page the panel loops over.
 */
describe('fullBackupBatch re-copies everything', () => {
  const okCopy = (size: number) => ({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ metadata: { size } })),
  });

  it('copies objects that are ALREADY in the ledger', async () => {
    // The incremental path anti-joins the ledger and would return nothing here.
    respondByTag({
      'storageBackup.full.total': () => ({ rows: [{ total: 2 }] }),
      'storageBackup.full.page': () => ({
        rows: [
          { bucket_id: 'record-docs', name: 'already-mirrored.pdf', size: '5' },
          { bucket_id: 'rep-docs', name: 'also-mirrored.pdf', size: '6' },
        ],
      }),
      'storageBackup.markBackedUp': () => ({ rows: [] }),
    });
    mockFetch.mockImplementation((_u: string, init: any) =>
      Promise.resolve(init?.method === 'DELETE' ? { ok: true, text: () => Promise.resolve('') } : okCopy(JSON.parse(init.body).sourceKey === 'already-mirrored.pdf' ? 5 : 6))
    );

    const res = await fullBackupBatch(ENV, null);
    expect(res.copied).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.total).toBe(2);
    // Short page => the sweep is done, so no cursor to continue from.
    expect(res.cursor).toBeNull();
  });

  it('upserts rather than deleting first, so the mirror is never briefly empty', async () => {
    // The first cut deleted the destination then copied. When the delete
    // failed the copy never ran, and the mirrored file was simply gone - that
    // punched real holes in the mirror. One copy carrying 'x-upsert: true'
    // replaces the object in place, with no window where it does not exist.
    respondByTag({
      'storageBackup.full.total': () => ({ rows: [{ total: 1 }] }),
      'storageBackup.full.page': () => ({ rows: [{ bucket_id: 'record-docs', name: 'a.pdf', size: '3' }] }),
      'storageBackup.markBackedUp': () => ({ rows: [] }),
    });
    mockFetch.mockImplementation(() => Promise.resolve(okCopy(3)));

    const res = await fullBackupBatch(ENV, null);
    expect(res.copied).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['x-upsert']).toBe('true');
    expect(mockFetch.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
  });

  it('does NOT upsert on the incremental path, so a 409 still means something', async () => {
    respondByTag({
      'cron.scheduledJob.tier': () => ({ rows: [{ cron_tier: 'nightly' }] }),
      'storageBackup.pending': (params) => ({
        rows: params[0] === 'record-docs' ? [{ name: 'a.pdf', size: '3' }] : [],
      }),
      'storageBackup.markBackedUp': () => ({ rows: [] }),
    });
    mockFetch.mockImplementation(() => Promise.resolve(okCopy(3)));

    await backupStorageToSupabase(ENV);
    expect(mockFetch.mock.calls[0][1].headers['x-upsert']).toBeUndefined();
  });

  it('splits the cursor on the FIRST slash, so paths containing slashes survive', async () => {
    // bucket ids never contain "/", object paths usually do (order/123/x.pdf).
    let seen: any[] = [];
    respondByTag({
      'storageBackup.full.total': () => ({ rows: [{ total: 0 }] }),
      'storageBackup.full.page': (params) => { seen = params; return { rows: [] }; },
    });
    await fullBackupBatch(ENV, 'record-docs/order/123/packing slip.pdf');
    expect(seen[1]).toBe('record-docs');
    expect(seen[2]).toBe('order/123/packing slip.pdf');
  });

  it('hands back a cursor when the page is full, so the panel keeps going', async () => {
    // A full page means there is probably more after it.
    // A full page is BATCH_SIZE (300) now that each object is one upsert copy
    // rather than a delete plus a copy.
    const rows = Array.from({ length: 300 }, (_, i) => ({
      bucket_id: 'record-docs', name: `doc-${String(i).padStart(3, '0')}.pdf`, size: '1',
    }));
    respondByTag({
      'storageBackup.full.total': () => ({ rows: [{ total: 1000 }] }),
      'storageBackup.full.page': () => ({ rows }),
      'storageBackup.markBackedUp': () => ({ rows: [] }),
    });
    mockFetch.mockImplementation((_u: string, init: any) =>
      Promise.resolve(init?.method === 'DELETE' ? { ok: true, text: () => Promise.resolve('') } : okCopy(1))
    );

    const res = await fullBackupBatch(ENV, null);
    expect(res.cursor).toBe('record-docs/doc-299.pdf');
    expect(res.total).toBe(1000);
  });
});
