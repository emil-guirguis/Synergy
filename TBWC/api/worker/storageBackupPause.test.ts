/**
 * The stop switch for the storage backup job (migration 107): parking
 * backupStorage on scheduled_job.cron_tier = 'off' has to do three things,
 * each of which was a real hole in the first cut:
 *   1. keep future cron ticks from running it (jobsForTier)
 *   2. make a run already in progress bail (backupBucket's periodic re-read)
 *   3. not resurrect the job via jobsForTier's pre-migration fallback, which
 *      fired on "tier has no rows" and so undid the stop entirely
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecQuery = vi.fn();
vi.mock('./db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

const mockFetchBytes = vi.fn();
vi.mock('@meterit/framework-backend/api/base/aiSearch', () => ({
  fetchDocumentBytes: (...a: any[]) => mockFetchBytes(...a),
}));

import { jobsForTier, isJobPaused, TIER_CRON, tierForCron } from './cronMonitor';
import { backupStorageToR2 } from './storageBackup';

const r2Put = vi.fn();
const ENV = { STORAGE_BACKUP: { put: r2Put } } as any;

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
  mockFetchBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe("'off' is not a runnable tier", () => {
  it('has no cron of its own, so no Cron Trigger can ever select it', () => {
    expect(Object.keys(TIER_CRON)).not.toContain('off');
    expect(tierForCron('0 10 */2 * *')).toBe('nightly');
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

describe('backupStorageToR2 honours the switch', () => {
  it('copies nothing at all while paused', async () => {
    respondByTag({ 'cron.scheduledJob.tier': () => ({ rows: [{ cron_tier: 'off' }] }) });
    await backupStorageToR2(ENV);
    expect(r2Put).not.toHaveBeenCalled();
    expect(mockFetchBytes).not.toHaveBeenCalled();
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

    await backupStorageToR2(ENV);

    // Stopped at the first mid-run check rather than copying all 100...
    expect(r2Put).toHaveBeenCalledTimes(25);
    // ...and the remaining buckets were skipped, not swept.
    const buckets = new Set(r2Put.mock.calls.map((c) => String(c[0]).split('/')[0]));
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

    await backupStorageToR2(ENV);
    expect(r2Put).toHaveBeenCalledTimes(1);
    expect(r2Put).toHaveBeenCalledWith('record-docs/a.pdf', expect.anything());
  });
});
