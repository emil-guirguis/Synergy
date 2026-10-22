/**
 * The backward pass over the mirror (storageBackup.ts's verifyBackupBatch).
 *
 * The sweep that fills the mirror only ever looks forward — it anti-joins the
 * storage_backup_object ledger, so an object it has copied once is never
 * examined again. Everything below is about what that leaves uncovered, and
 * each case here is a real failure shape this project has already seen:
 * mirror objects with no bytes behind them (the quote-doc audit found 404 of
 * 1456), a missing object answering 400 rather than 404, and Cloudflare's
 * per-invocation subrequest limit arriving mid-pass and being mistaken for
 * per-file failure (the `copied: 0, failed: 3125` runs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecQuery = vi.fn();
vi.mock('./db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import { verifyBackupBatch } from './storageBackup';

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

/** The ranged-GET answer for a mirror object that really has `size` bytes:
 *  206 plus the total after the slash in content-range. */
const realObject = (size: number) => ({
  status: 206,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-range' ? `bytes 0-0/${size}` : null) },
  text: () => Promise.resolve(''),
});

/** A mirror object with nothing behind it. 400, not 404 — this project's
 *  Storage API puts the 404 in the body and answers with a 400 status. */
const missingObject = () => ({
  status: 400,
  headers: { get: () => null },
  text: () => Promise.resolve('{"error":"not_found","statusCode":"404"}'),
});

const ledgerRow = (path: string, bytes: string, liveSize: string | null) => ({
  bucket: 'record-docs',
  storage_path: path,
  bytes,
  live_size: liveSize,
  source_exists: liveSize != null,
});

function isRangedGet(call: any[]): boolean {
  return (call[1]?.method ?? 'GET') === 'GET' && !!call[1]?.headers?.Range;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a mirror that is actually intact', () => {
  it('reports every object ok and changes nothing', async () => {
    respondByTag({
      'storageBackup.verify.page': () => ({
        rows: [ledgerRow('a.pdf', '10', '10'), ledgerRow('b.pdf', '20', '20')],
      }),
    });
    mockFetch.mockImplementation((url: string) => Promise.resolve(realObject(url.endsWith('a.pdf') ? 10 : 20)));

    const res = await verifyBackupBatch(ENV);

    expect(res).toEqual({ checked: 2, ok: 2, repaired: 0, lost: 0, failed: 0, cursor: null, stopped: false });
    // Verification is a read. Nothing was deleted and the ledger is untouched.
    expect(mockFetch.mock.calls.every(isRangedGet)).toBe(true);
    expect(mockExecQuery.mock.calls.map((c) => c[3])).toEqual(['storageBackup.verify.page']);
  });

  it('checks bytes with a ranged GET, never HEAD', async () => {
    // HEAD answers 200 for objects with no bytes behind them in this project,
    // so a HEAD-based check would call every ghost object healthy — the exact
    // blind spot this pass exists to close.
    respondByTag({ 'storageBackup.verify.page': () => ({ rows: [ledgerRow('a.pdf', '10', '10')] }) });
    mockFetch.mockResolvedValue(realObject(10));

    await verifyBackupBatch(ENV);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://x.test/storage/v1/object/storage-backup/record-docs/a.pdf');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Range).toBe('bytes=0-0');
  });
});

describe('what the forward-only sweep can never catch', () => {
  it('repairs a mirror object whose bytes are gone', async () => {
    const deleted: string[] = [];
    respondByTag({
      'storageBackup.verify.page': () => ({ rows: [ledgerRow('ghost.pdf', '10', '10')] }),
      'storageBackup.dropLedgerRow': (params) => { deleted.push(`${params[0]}/${params[1]}`); return { rows: [] }; },
    });
    mockFetch.mockImplementation((_url: string, init: any) =>
      Promise.resolve(init?.method === 'DELETE' ? { ok: true, status: 200, text: () => Promise.resolve('') } : missingObject())
    );

    const res = await verifyBackupBatch(ENV);

    expect(res).toMatchObject({ checked: 1, ok: 0, repaired: 1, lost: 0, failed: 0 });
    // Both sides cleared: the dead mirror object AND its ledger row, which is
    // what puts the file back in pendingObjects' sight.
    expect(deleted).toEqual(['record-docs/ghost.pdf']);
    const deleteCalls = mockFetch.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe('https://x.test/storage/v1/object/storage-backup/record-docs/ghost.pdf');
  });

  it('repairs a source that was replaced in place after it was mirrored', async () => {
    // Same bucket, same path, new bytes: the ledger row already exists, so the
    // sweep skips it forever and the mirror keeps the old version. Only a
    // size comparison against the source's CURRENT size finds it.
    respondByTag({
      'storageBackup.verify.page': () => ({ rows: [ledgerRow('replaced.pdf', '10', '999')] }),
      'storageBackup.dropLedgerRow': () => ({ rows: [] }),
    });
    mockFetch.mockImplementation((_url: string, init: any) =>
      Promise.resolve(init?.method === 'DELETE' ? { ok: true, status: 200, text: () => Promise.resolve('') } : realObject(10))
    );

    const res = await verifyBackupBatch(ENV);

    expect(res).toMatchObject({ checked: 1, repaired: 1, ok: 0, lost: 0 });
    // Deleting the stale object is not optional housekeeping: object/copy has
    // no upsert, so a re-copy over a surviving one would 409 forever.
    expect(mockFetch.mock.calls.filter((c) => c[1]?.method === 'DELETE')).toHaveLength(1);
  });

  it('calls a rotten copy of an already-deleted file unrecoverable, not repairable', async () => {
    // Nothing left to re-copy from, so queueing it would be a lie. The ledger
    // row goes anyway — leaving it would keep claiming the file is backed up.
    const deleted: string[] = [];
    respondByTag({
      'storageBackup.verify.page': () => ({ rows: [ledgerRow('gone.pdf', '10', null)] }),
      'storageBackup.dropLedgerRow': (params) => { deleted.push(`${params[0]}/${params[1]}`); return { rows: [] }; },
    });
    mockFetch.mockResolvedValue(missingObject());

    const res = await verifyBackupBatch(ENV);

    expect(res).toMatchObject({ checked: 1, lost: 1, repaired: 0, ok: 0 });
    expect(deleted).toEqual(['record-docs/gone.pdf']);
    // No point deleting a mirror object that already has no bytes.
    expect(mockFetch.mock.calls.filter((c) => c[1]?.method === 'DELETE')).toHaveLength(0);
  });

  it('still verifies a deleted file whose backup is fine, against the size it was copied at', async () => {
    // The backup of a file someone deleted is the copy that matters most, and
    // there is no live source left to compare it with — the ledger's recorded
    // size is.
    respondByTag({ 'storageBackup.verify.page': () => ({ rows: [ledgerRow('gone-but-safe.pdf', '42', null)] }) });
    mockFetch.mockResolvedValue(realObject(42));

    expect(await verifyBackupBatch(ENV)).toMatchObject({ checked: 1, ok: 1, lost: 0, repaired: 0 });
  });

  it("leaves a copy it couldn't check alone, for the next pass", async () => {
    respondByTag({ 'storageBackup.verify.page': () => ({ rows: [ledgerRow('a.pdf', '10', '10')] }) });
    mockFetch.mockResolvedValue({ status: 503, headers: { get: () => null }, text: () => Promise.resolve('upstream') });

    const res = await verifyBackupBatch(ENV);

    expect(res).toMatchObject({ checked: 1, failed: 1, repaired: 0, lost: 0, ok: 0 });
    // Crucially NOT repaired: a 503 says nothing about the bytes, and deleting
    // a healthy mirror object on the strength of one would destroy the backup
    // this pass is supposed to protect.
    expect(mockExecQuery.mock.calls.map((c) => c[3])).not.toContain('storageBackup.dropLedgerRow');
  });
});

describe('the subrequest limit', () => {
  it('stops the call cleanly instead of reporting healthy files as unchecked', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ledgerRow(`doc-${i}.pdf`, '1', '1'));
    respondByTag({ 'storageBackup.verify.page': () => ({ rows }) });
    let served = 0;
    mockFetch.mockImplementation(() => {
      served++;
      if (served > 25) return Promise.reject(new Error('Too many subrequests by single Worker invocation.'));
      return Promise.resolve(realObject(1));
    });

    const res = await verifyBackupBatch(ENV);

    expect(res.checked).toBe(25);
    expect(res.ok).toBe(25);
    // The whole point: an exhausted invocation is not 35 unverifiable files.
    expect(res.failed).toBe(0);
    expect(res.stopped).toBe(true);
    // And it resumes from the last chunk that actually finished, so nothing is
    // silently skipped.
    expect(res.cursor).toBe('record-docs/doc-24.pdf');
  });

  it('hands back the cursor it was given when even the first chunk is spent', async () => {
    // The panel's loop has to notice this and stop rather than re-POST the
    // same cursor forever — see its `stalled` counter.
    const rows = Array.from({ length: 60 }, (_, i) => ledgerRow(`doc-${i}.pdf`, '1', '1'));
    respondByTag({ 'storageBackup.verify.page': () => ({ rows }) });
    mockFetch.mockRejectedValue(new Error('Too many subrequests by single Worker invocation.'));

    const res = await verifyBackupBatch(ENV, 'record-docs/earlier.pdf');

    expect(res).toMatchObject({ checked: 0, failed: 0, stopped: true, cursor: 'record-docs/earlier.pdf' });
  });
});

describe('paging through the whole ledger', () => {
  it('splits the cursor back into (bucket, path) for the keyset comparison', async () => {
    // Paths contain slashes of their own (quotes/123/file.pdf), so only the
    // FIRST one separates the bucket from the path.
    let params: any[] = [];
    respondByTag({
      'storageBackup.verify.page': (p) => { params = p; return { rows: [] }; },
    });

    await verifyBackupBatch(ENV, 'record-docs/quotes/123/file.pdf');

    expect(params[0]).toBe('record-docs');
    expect(params[1]).toBe('quotes/123/file.pdf');
  });

  it('starts from the beginning of the ledger with no cursor', async () => {
    let params: any[] = [];
    respondByTag({ 'storageBackup.verify.page': (p) => { params = p; return { rows: [] }; } });

    const res = await verifyBackupBatch(ENV);

    expect([params[0], params[1]]).toEqual(['', '']);
    expect(res.cursor).toBeNull();
  });

  it('hands back a cursor while a full page comes back, and null once one does not', async () => {
    const full = Array.from({ length: 150 }, (_, i) => ledgerRow(`doc-${i}.pdf`, '1', '1'));
    respondByTag({ 'storageBackup.verify.page': () => ({ rows: full }) });
    mockFetch.mockResolvedValue(realObject(1));

    const first = await verifyBackupBatch(ENV);
    expect(first.checked).toBe(150);
    expect(first.cursor).toBe('record-docs/doc-149.pdf');
    expect(first.stopped).toBe(false);

    respondByTag({ 'storageBackup.verify.page': () => ({ rows: full.slice(0, 3) }) });
    expect((await verifyBackupBatch(ENV, first.cursor)).cursor).toBeNull();
  });
});
