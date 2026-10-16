/**
 * Settings > Quote Import — rerunnable fix-up pass over quotes already in
 * the system (public.quote, imported in bulk by api/scripts/import-quotes*
 * .cjs). Pick the same local "2026 Quotes" folder again any time: one
 * subfolder per job, matched to its existing quote by (normalized) job name.
 * This never creates a new quote — only existing rows get touched — so there
 * is no customer picker and no risk of duplicating the original bulk import.
 *
 * For each matched quote this checks three things and only fixes what's
 * actually wrong, same "rerun = only retry what failed" spirit as the old
 * DocumentImportPanel (git history: features/documentImport, removed
 * 2026-10-13 in favor of the CLI scripts — this restores that pattern for
 * quotes specifically):
 *
 *  1. Documents: EVERY local file is uploaded, over the top of whatever is
 *     already attached under the same name. No detection, deliberately — no
 *     remote check can answer the question that actually matters ("does this
 *     file open?"): the stored byte count matches the DB's file_size column
 *     on every object that still has bytes, a HEAD returns 200 for ones that
 *     don't, and a 2026-10-16 sample of 40 stored PDFs found every present
 *     one structurally whole. Two rounds of heuristics (file_size column,
 *     then HEAD) both reported "up to date" over files nobody could open, so
 *     the heuristics are gone. The upload is verified in the bucket before
 *     the superseded document row is retired, so a failure leaves the old
 *     one attached rather than nothing at all. Documents with no local
 *     counterpart in the folder are never touched.
 *  2. Line items: only touched when the quote currently has ZERO lines
 *     recorded (never overwrites existing — possibly hand-corrected — lines).
 *     Parses the Bill-of-Materials table from the primary quote PDF's first
 *     3 pages only (not the whole document — some of these run 20-50 pages,
 *     and the cover page + BOM table always land in the first 3).
 *  3. Total: quote.total is always SUM(quote_line.amount) server-side now
 *     (routes/quotes.ts), so a quote whose PDF never prints a per-line price
 *     (some template revisions hide it) ends up with total = 0 even once its
 *     lines are inserted. When that happens and the PDF's own cover-page
 *     total parses fine, one placeholder line captures it so the total shows
 *     correctly — see buildLinePayloads().
 */
import React, { useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, LinearProgress, Tooltip, Typography } from '@mui/material';
import DriveFolderUploadIcon from '@mui/icons-material/DriveFolderUpload';
import DownloadIcon from '@mui/icons-material/Download';
import {
  formatFileSize,
  storagePathFor,
  type DocType,
  type DocumentRecord,
} from '@meterit/framework-frontend/documents';
import { ImportPanel, StatusChip, downloadCsv, type ImportColumn, type ImportFacet } from '@meterit/framework-frontend/import';
import { documentsApi, documentsStorage, RECORD_DOCS_BUCKET } from '../../services/documentsClient';
import { quotesService, quoteLinesApi } from './quotesStore';
import { extractQuotePdf, mergeHeaders, type ParsedQuoteHeader, type ParsedQuoteLine } from './quotePdfParse';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../config/api';
import { tokenStorage } from '../../utils/tokenStorage';

const IGNORED_FILE_NAMES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);
const MAX_PARSE_PAGES = 3;

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.msg': 'application/vnd.ms-outlook',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Every non-email PDF in a job folder is a quote revision candidate — simpler than (and
 *  deliberately not) the shared order-oriented classifyDocType(), which would misfile one
 *  as 'build_of_materials'/'order'/etc. off words like "bom"/"hfr" in its filename and drop
 *  it from BOM-table parsing. Mirrors scripts/import-quotes-from-folders.cjs's own classify(). */
function classifyQuoteFile(relPath: string): DocType {
  if (/\.pdf$/i.test(relPath)) return /email/i.test(relPath) ? 'email' : 'quote';
  if (/\.msg$/i.test(relPath)) return 'email';
  return 'other';
}

function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** Same normalization as the CLI importers, so a folder name with different spacing/
 *  punctuation than the DB's job_name still matches. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface QuoteMatch {
  quote_id: number;
  ref_number: string | null;
  customer_name: string | null;
  job_name: string | null;
  total: number | null;
}

/** No detection: every local file is written. 'replace' only records that an older row
 *  with the same file name has to be retired once the fresh upload lands. */
type DocStatus = 'upload' | 'replace';

interface DocPlan {
  relPath: string;
  fileName: string;
  file: File;
  size: number;
  docType: DocType;
  status: DocStatus;
  existingDocumentId?: number;
  existingStoragePath?: string | null;
}

type EntryStatus = 'no-match' | 'up-to-date' | 'ready' | 'success' | 'partial' | 'failed';

/** Per-item failure detail. The run used to collapse a whole job into one "N failed: <last
 *  message>" string, which on a 600-folder sweep told you nothing about WHICH file broke —
 *  so every failure now carries the job folder, the path inside it, and the size. */
interface ItemFailure {
  /** Job folder name — the directory under the picked root. */
  jobName: string;
  /** Path inside the job folder (may contain subdirectories), '' for a line-item failure. */
  relPath: string;
  size: number | null;
  stage: 'upload' | 'verify' | 'metadata' | 'line-item';
  timedOut: boolean;
  message: string;
}

function failureLabel(f: ItemFailure): string {
  const where = f.relPath ? `${f.jobName}/${f.relPath}` : f.jobName;
  const size = f.size != null ? ` (${formatFileSize(f.size)})` : '';
  return `${where}${size}: ${f.message}`;
}

interface Entry {
  key: string;
  /** 1-based planning order — the number the progress bar counts off, so "stuck on 7" is
   *  answerable from the table alone. */
  index: number;
  jobName: string;
  quote: QuoteMatch | null;
  docs: DocPlan[];
  parsedLines: ParsedQuoteLine[];
  parsedTotal: number | null;
  existingLineCount: number;
  linePayloads: Array<{ qb_item_id: null; item_name: string | null; description: string; quantity: number; rate: number }>;
  status: EntryStatus;
  message: string;
  failures: ItemFailure[];
  result?: { uploaded: number; failed: number; linesInserted: number; timedOut: number };
}

const STATUS_LABELS: Record<EntryStatus, string> = {
  'no-match': 'no matching quote',
  'up-to-date': 'nothing to upload',
  ready: 'will overwrite',
  success: 'overwritten',
  partial: 'partly overwritten',
  failed: 'failed',
};
const STATUS_COLOR: Record<EntryStatus, 'success' | 'default' | 'error' | 'warning' | 'info'> = {
  'no-match': 'error',
  'up-to-date': 'default',
  ready: 'info',
  success: 'success',
  partial: 'warning',
  failed: 'error',
};

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `quote-import-${keySeq}`;
}

/**
 * Lines come from whichever quote-candidate PDF parses the most BOM rows —
 * ground truth beats a filename guess. The header (date/rep/total/engineer)
 * is merged across EVERY candidate instead of just that one file: a revision
 * with more line items isn't necessarily the one whose cover page actually
 * printed the total, so stopping at the "best" file's own header was
 * dropping totals that a second or third PDF in the same folder did have.
 */
async function pickPrimary(candidates: DocPlan[]): Promise<{ header: ParsedQuoteHeader; lines: ParsedQuoteLine[] }> {
  const headers: ParsedQuoteHeader[] = [];
  let bestLines: ParsedQuoteLine[] = [];
  for (const doc of candidates) {
    try {
      const parsed = await extractQuotePdf(doc.file, MAX_PARSE_PAGES);
      headers.push(parsed.header);
      if (parsed.lines.length > bestLines.length) bestLines = parsed.lines;
    } catch {
      // unreadable/corrupt PDF — leave it out of the parse, still gets uploaded as a document
    }
  }
  return { header: mergeHeaders(headers), lines: bestLines };
}

/** Real BOM lines first; if none of them carry a price AND the cover page's own total parsed,
 *  one placeholder line captures that total so quote.total (always SUM(quote_line.amount)) isn't 0. */
function buildLinePayloads(lines: ParsedQuoteLine[], parsedTotal: number | null) {
  const payloads = lines.map((l) => ({
    qb_item_id: null as null,
    item_name: l.itemName || null,
    description: l.description,
    quantity: Math.max(0, Math.round(l.quantity) || 0),
    rate: l.rate ?? 0,
  }));
  const hasPricedLine = lines.some((l) => (l.amount ?? 0) > 0);
  if (!hasPricedLine && parsedTotal && parsedTotal > 0) {
    payloads.push({
      qb_item_id: null,
      item_name: null,
      description: '(Total from PDF cover page — this revision does not print per-line pricing)',
      quantity: 1,
      rate: parsedTotal,
    });
  }
  return payloads;
}

function encodeStoragePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

const STORED_SIZE_TIMEOUT_MS = 8000;
const PLAN_FETCH_TIMEOUT_MS = 15000;
const PLAN_PARSE_TIMEOUT_MS = 20000;
/** Metadata calls during the run (document row create/delete, line insert) — small JSON
 *  round trips through the Worker, so anything past this is a hang, not slowness. */
const RUN_API_TIMEOUT_MS = 30000;
/** Floor for a byte upload, plus one second per 50 KB (≈50 KB/s — deliberately slower than
 *  any real link, so only a genuinely stalled transfer trips it), capped at 5 minutes. */
const UPLOAD_TIMEOUT_FLOOR_MS = 60000;
const UPLOAD_TIMEOUT_CEILING_MS = 300000;
function uploadTimeoutFor(size: number): number {
  return Math.min(UPLOAD_TIMEOUT_CEILING_MS, Math.max(UPLOAD_TIMEOUT_FLOOR_MS, (size / (50 * 1024)) * 1000));
}

/** Caps how long the planning loop will wait on any single await — a plan over hundreds
 *  of jobs can't afford one job's network call or PDF parse to hang forever and stall
 *  every job behind it. Unlike checkStoredObject's AbortController, this can't cancel the
 *  underlying work (documentsApi/quoteLinesApi/pickPrimary take no abort signal) — it just
 *  stops the planning loop from waiting on it and moves on with `fallback`. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

/** Marks a step that blew its deadline, so the run can log it as a timeout (with the file
 *  and how long it waited) instead of a generic "failed". */
class StepTimeoutError extends Error {
  step: string;
  ms: number;
  constructor(step: string, ms: number) {
    super(`Timed out after ${Math.round(ms / 1000)}s (${step}).`);
    this.name = 'StepTimeoutError';
    this.step = step;
    this.ms = ms;
  }
}

/** Run-phase deadline. Unlike planning's withTimeout (which resolves a fallback and shrugs),
 *  a blown deadline here REJECTS: during the run every step matters, and the whole point is
 *  to record which file stalled rather than silently carry on. `abort` is passed for the one
 *  call that can really be cancelled (the storage upload) — everything else is left running
 *  in the background and only stops being waited on. */
function withDeadline<T>(step: string, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new StepTimeoutError(step, ms));
    }, ms);
    run(controller.signal).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => {
        clearTimeout(timer);
        // An abort raised by our own timer surfaces as the timeout, not as "aborted".
        if (controller.signal.aborted) reject(new StepTimeoutError(step, ms));
        else reject(err);
      }
    );
  });
}

type StoredObjectCheck =
  /** Bytes are really there. `size` is null when the object exists but its length
   *  couldn't be read — callers then fall back to the DB's file_size column. */
  | { status: 'found'; size: number | null }
  | { status: 'missing' } // confirmed absent — the object genuinely isn't in the bucket
  | { status: 'unknown' }; // couldn't tell (no token/network/CORS/timeout)

/**
 * Supabase Storage reports a genuinely absent object as **HTTP 400** with a body of
 * `{"statusCode":"404","error":"not_found","message":"Object not found","code":"NoSuchKey"}`
 * — the HTTP status is 400, the 404 is only inside the JSON. The old probe tested
 * `res.status === 404`, so it NEVER recognised an absent object: every dead document fell
 * through to 'unknown', the plan fell back to the DB's file_size column (which matches,
 * since the bulk CLI importer wrote the row and the bytes from the same fs.statSync), the
 * document was classified 'already', and the whole quote came out "up to date" with nothing
 * queued. Verified against record-docs on 2026-10-16: 404 of 1456 quote documents across
 * 157 quotes answer exactly this, and every one of them was being reported as fine.
 */
async function isObjectAbsent(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.ok) return false;
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { statusCode?: unknown; error?: unknown; code?: unknown };
    return parsed?.code === 'NoSuchKey' || parsed?.error === 'not_found' || String(parsed?.statusCode) === '404';
  } catch {
    return /nosuchkey|object not found|not_?found/i.test(body);
  }
}

/** Post-upload verification ONLY — nothing in the plan consults this any more. Read what
 *  actually landed in the bucket for an object we just wrote ourselves, where we know the
 *  expected byte count exactly; that is a question a remote check can answer, unlike "is
 *  this months-old file openable", which it cannot (see the header comment).
 *  Distinguishes a confirmed-absent object from "couldn't check" (network blip), so a blip
 *  never causes a good upload to be thrown away.
 *
 *  Existence is settled by a ONE-BYTE RANGED GET, not a HEAD. A HEAD is answered out of
 *  the object's metadata row and so reports 200 for a path whose bytes are gone (Villa
 *  Hermosa, 2026-10-15: HEAD said found, the download 404'd), and a HEAD carries no body,
 *  so there is no way to read the not_found marker out of Supabase's 400 either. A ranged
 *  GET travels the same path as a user clicking the document, costs one byte, and comes
 *  back with a readable error body — see isObjectAbsent.
 *
 *  Size comes from a parallel HEAD, because `content-range` on the 206 is NOT a
 *  CORS-safelisted response header and Supabase sends no Access-Control-Expose-Headers,
 *  so browser JS cannot read it; `content-length` on the HEAD is safelisted. Both requests
 *  are in flight together, so this still costs one round trip of wall time, and a failed
 *  HEAD only costs the (informational) size comparison, never the existence verdict.
 *
 *  Hard-timed out: a plan over hundreds of jobs awaits this per-document, and a single
 *  request that never resolves would otherwise hang the run at whichever job hit it. */
async function checkStoredObject(storagePath: string): Promise<StoredObjectCheck> {
  const token = tokenStorage.getToken();
  if (!token) return { status: 'unknown' };
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${RECORD_DOCS_BUCKET}/${encodeStoragePath(storagePath)}`;
  const auth = { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORED_SIZE_TIMEOUT_MS);
  try {
    const [bytes, meta] = await Promise.all([
      fetch(url, { method: 'GET', headers: { ...auth, Range: 'bytes=0-0' }, signal: controller.signal }),
      fetch(url, { method: 'HEAD', headers: auth, signal: controller.signal }).catch(() => null),
    ]);
    if (await isObjectAbsent(bytes)) return { status: 'missing' };
    if (!bytes.ok) return { status: 'unknown' };
    const len = meta && meta.ok ? meta.headers.get('content-length') : null;
    return { status: 'found', size: len == null ? null : Number(len) };
  } catch {
    return { status: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort: a check that couldn't be answered doesn't block the run — but a confirmed
 *  absence right after an upload we just made IS a reliable "no, it didn't take" signal. */
async function verifyStoredSize(storagePath: string, expectedSize: number): Promise<boolean> {
  const check = await checkStoredObject(storagePath);
  if (check.status === 'found' && check.size != null) return check.size === expectedSize;
  return check.status !== 'missing';
}

// framework/backend/api/base/documents.ts's DEFAULT_MAX_FILE_SIZE — the Worker rejects the
// metadata insert above this regardless of what the frontend does, but only AFTER the raw
// bytes already landed in storage (that part bypasses the Worker entirely). Checking here
// first fails fast with a clear reason instead of wasting the upload and surfacing a vague
// error — and, critically, still shows up as a real logged failure rather than being
// silently excluded from the plan the way the old 'too-large' status used to.
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

interface UploadOutcome {
  ok: boolean;
  message: string;
  timedOut: boolean;
  stage: ItemFailure['stage'];
}

/**
 * Every network step here is on a deadline. Before 2026-10-16 none of them were: the byte
 * upload is a plain fetch with no abort signal, so one stalled POST parked the whole run on
 * whichever job hit it, with a progress bar that just stopped moving and no way to tell
 * which file it was sitting on. The upload is genuinely cancelled (its signal reaches
 * fetch); the Worker calls are only stopped being waited on.
 */
async function uploadDocOnce(quoteId: number, doc: DocPlan): Promise<UploadOutcome> {
  if (doc.size > MAX_UPLOAD_SIZE) {
    return {
      ok: false,
      timedOut: false,
      stage: 'upload',
      message: `File too large to attach (${formatFileSize(doc.size)} exceeds the ${formatFileSize(MAX_UPLOAD_SIZE)} limit) — not uploaded.`,
    };
  }
  const path = storagePathFor('quote', String(quoteId), doc.fileName);
  let stage: ItemFailure['stage'] = 'upload';
  try {
    await withDeadline(`uploading ${formatFileSize(doc.size)}`, uploadTimeoutFor(doc.size), (signal) =>
      documentsStorage.upload(path, doc.file, signal)
    );
    stage = 'verify';
    const sizeOk = await verifyStoredSize(path, doc.size);
    if (!sizeOk) {
      await documentsStorage.remove(path).catch(() => undefined);
      return {
        ok: false,
        timedOut: false,
        stage: 'verify',
        message: `Uploaded bytes didn't match the local file (${formatFileSize(doc.size)}).`,
      };
    }
    stage = 'metadata';
    await withDeadline('saving the document row', RUN_API_TIMEOUT_MS, () =>
      documentsApi.create({
        entityType: 'quote',
        entityId: String(quoteId),
        fileName: doc.fileName,
        storageBucket: RECORD_DOCS_BUCKET,
        storagePath: path,
        docType: doc.docType,
        mimeType: mimeFor(doc.file),
        fileSize: doc.size,
      })
    );
    return { ok: true, timedOut: false, stage, message: 'Uploaded.' };
  } catch (e: any) {
    const timedOut = e instanceof StepTimeoutError;
    // A timed-out upload may still be in flight server-side; the bytes it might leave behind
    // are unreferenced (no document row was written), so drop them best-effort.
    if (timedOut && stage === 'upload') void documentsStorage.remove(path).catch(() => undefined);
    return { ok: false, timedOut, stage, message: e?.message || 'Upload failed.' };
  }
}

/** One retry on a verified size mismatch or a transient upload error — a 4xx validation
 *  error (bad path, oversized file) would just fail the same way twice, but a truncated
 *  transfer often doesn't repeat. A timeout is NOT retried: it already cost the full
 *  deadline, and a second one would double the stall on every remaining job. */
async function uploadDocWithRetry(quoteId: number, doc: DocPlan): Promise<UploadOutcome> {
  const first = await uploadDocOnce(quoteId, doc);
  if (first.ok || first.timedOut) return first;
  return uploadDocOnce(quoteId, doc);
}

function groupByJobFolder(files: File[]): Map<string, { relPath: string; file: File }[]> {
  const groups = new Map<string, { relPath: string; file: File }[]>();
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split('/');
    if (parts.length < 2) continue; // not inside a picked folder at all
    const jobName = parts[1]?.trim();
    if (!jobName) continue;
    const relPath = parts.slice(2).join('/') || parts[parts.length - 1];
    if (!groups.has(jobName)) groups.set(jobName, []);
    groups.get(jobName)!.push({ relPath, file });
  }
  return groups;
}

/** Job-level log: one row per planned folder, numbered the same way the table and the
 *  progress bar number them. */
function downloadLog(entries: Entry[]): void {
  const header = ['#', 'Job Folder', 'Quote', 'Documents', 'Line Items', 'Parsed Total', 'Status', 'Timed Out', 'Failed Files', 'Message'];
  const rows = entries.map((e) => [
    String(e.index),
    e.jobName,
    e.quote?.ref_number || '',
    `${e.docs.filter((d) => d.status === 'replace').length} overwrite, ${e.docs.filter((d) => d.status === 'upload').length} new`,
    e.linePayloads.length ? `${e.linePayloads.length} to insert` : e.existingLineCount ? `${e.existingLineCount} already present` : 'none found',
    e.parsedTotal != null ? String(e.parsedTotal) : '',
    STATUS_LABELS[e.status],
    String(e.failures.filter((f) => f.timedOut).length),
    e.failures.map(failureLabel).join(' | '),
    e.message,
  ]);
  downloadCsv('quote-import-log', header, rows);
}

/** File-level log: one row per failed file, so a stalled or broken file is identified by
 *  folder + path + size + which step blew up, instead of being buried in a job summary. */
function downloadFailureLog(entries: Entry[]): void {
  const header = ['#', 'Job Folder', 'File', 'Directory In Folder', 'Size (bytes)', 'Stage', 'Timed Out', 'Message'];
  const rows: string[][] = [];
  for (const e of entries) {
    for (const f of e.failures) {
      const dir = f.relPath.includes('/') ? f.relPath.slice(0, f.relPath.lastIndexOf('/')) : '';
      rows.push([
        String(e.index),
        f.jobName,
        f.relPath || '(line items)',
        dir,
        f.size != null ? String(f.size) : '',
        f.stage,
        f.timedOut ? 'yes' : 'no',
        f.message,
      ]);
    }
  }
  downloadCsv('quote-import-failures', header, rows);
}

export const QuoteImportPanel: React.FC = () => {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [planningProgress, setPlanningProgress] = useState<{ done: number; total: number; jobName: string } | null>(null);
  /** `current` names the exact file being written right now — a run that stops moving is
   *  then self-explanatory ("quote 7, this file"), which is the whole reason it exists. */
  const [progress, setProgress] = useState<
    { done: number; total: number; index: number; jobName: string; file: string; fileNo: number; fileCount: number } | null
  >(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [statusFilter, setStatusFilter] = useState<EntryStatus | 'all'>('all');
  const [runError, setRunError] = useState<{ jobName: string; index: number; message: string } | null>(null);

  React.useEffect(() => {
    const el = folderInputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  const buildPlan = async (picked: File[]) => {
    setPlanning(true);
    setEntries([]);
    const usable = picked.filter((f) => !f.name.startsWith('.') && !IGNORED_FILE_NAMES.has(f.name));
    const groups = groupByJobFolder(usable);
    setPlanningProgress({ done: 0, total: groups.size, jobName: '' });

    // One list call covers every quote that has a job_name at all — cheap even at ~150+ rows,
    // and avoids a round trip per folder just to resolve the match.
    const { items: allQuotes } = await quotesService.getAll({ limit: 2000 });
    const quoteByJobName = new Map<string, QuoteMatch>();
    for (const q of allQuotes as QuoteMatch[]) {
      if (q.job_name) quoteByJobName.set(normalize(q.job_name), q);
    }

    const rows: Entry[] = [];
    let done = 0;
    for (const [jobName, files] of groups) {
      setPlanningProgress((p) => (p ? { ...p, jobName } : p));
      try {
        const quote = quoteByJobName.get(normalize(jobName)) ?? null;
        const docsRaw: DocPlan[] = files.map(({ relPath, file }) => ({
          relPath,
          fileName: relPath.split('/').pop() || relPath,
          file,
          size: file.size,
          docType: classifyQuoteFile(relPath),
          status: 'upload',
        }));

        if (!quote) {
          rows.push({
            key: nextKey(), index: rows.length + 1, jobName, quote: null, docs: docsRaw, parsedLines: [], parsedTotal: null,
            existingLineCount: 0, linePayloads: [], status: 'no-match', failures: [],
            message: `No existing quote with job_name matching "${jobName}" — this tool only fixes quotes already in the system, never creates new ones.`,
          });
          continue;
        }

        const [existingDocs, existingLines] = await Promise.all([
          withTimeout(documentsApi.list('quote', String(quote.quote_id)).catch(() => [] as DocumentRecord[]), PLAN_FETCH_TIMEOUT_MS, [] as DocumentRecord[]),
          withTimeout(quoteLinesApi.list(quote.quote_id).catch(() => [] as any[]), PLAN_FETCH_TIMEOUT_MS, [] as any[]),
        ]);
        const existingByName = new Map(existingDocs.map((d) => [d.file_name.trim().toLowerCase(), d]));

        // No probing. Every local file is uploaded over whatever is attached under the same
        // name, because no remote check can actually answer "is this file openable": the
        // stored byte count matches the DB column on every object that still has bytes, and
        // a HEAD reports 200 for ones that don't. Planning therefore costs two API calls per
        // job (documents + lines) instead of two network round trips per document, which is
        // what made a full sweep of ~600 folders impractical.
        const docs: DocPlan[] = docsRaw.map((d) => {
          const existing = existingByName.get(d.fileName.trim().toLowerCase());
          if (!existing) return { ...d, status: 'upload' as DocStatus };
          return {
            ...d,
            status: 'replace' as DocStatus,
            existingDocumentId: existing.document_id,
            existingStoragePath: existing.storage_path,
          };
        });

        const quoteCandidates = docs.filter((d) => d.docType === 'quote');
        const { header, lines: parsedLines } = await withTimeout(
          pickPrimary(quoteCandidates),
          PLAN_PARSE_TIMEOUT_MS,
          { header: mergeHeaders([]), lines: [] as ParsedQuoteLine[] }
        );
        const parsedTotal = header.total ?? null;
        const linePayloads = existingLines.length === 0 ? buildLinePayloads(parsedLines, parsedTotal) : [];

        const toUpload = docs.filter((d) => d.status === 'upload').length;
        const toReplace = docs.filter((d) => d.status === 'replace').length;
        const needsWork = docs.length > 0 || linePayloads.length > 0;

        const bits: string[] = [];
        if (toReplace) bits.push(`${toReplace} attached document(s) will be overwritten from your local copy`);
        if (toUpload) bits.push(`${toUpload} new document(s) to attach`);
        if (linePayloads.length) bits.push(`${linePayloads.length} line item(s) parsed from "${quoteCandidates.find((c) => c.docType === 'quote')?.fileName ?? 'the quote PDF'}" (currently has none)`);
        else if (existingLines.length === 0 && quoteCandidates.length === 0) bits.push('no quote PDF found to parse lines from');
        else if (existingLines.length === 0) bits.push('no BOM table found in the first 3 pages');
        if (!needsWork) bits.push('no local files in this folder and nothing to parse');

        rows.push({
          key: nextKey(), index: rows.length + 1, jobName, quote, docs, parsedLines, parsedTotal,
          existingLineCount: existingLines.length, linePayloads, failures: [],
          status: needsWork ? 'ready' : 'up-to-date',
          message: bits.join('; ') + '.',
        });
      } finally {
        done += 1;
        setEntries([...rows]);
        setPlanningProgress((p) => (p ? { ...p, done } : p));
      }
    }

    setPlanningProgress(null);
    setPlanning(false);
  };

  const handleFolderChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    setRunError(null);
    if (picked.length) void buildPlan(picked);
  };

  const runImport = async () => {
    const ready = entries.filter((e) => e.status === 'ready');
    if (!ready.length) return;
    setRunning(true);
    setRunError(null);
    setProgress({
      done: 0, total: ready.length, index: ready[0].index, jobName: ready[0].jobName,
      file: '', fileNo: 0, fileCount: ready[0].docs.length,
    });

    const setEntry = (key: string, patch: Partial<Entry>) =>
      setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));

    for (const entry of ready) {
      const quoteId = entry.quote!.quote_id;
      let uploaded = 0;
      let replaced = 0;
      let failed = 0;
      const failures: ItemFailure[] = [];

      setProgress((p) =>
        p ? { ...p, index: entry.index, jobName: entry.jobName, file: '', fileNo: 0, fileCount: entry.docs.length } : p
      );

      for (let i = 0; i < entry.docs.length; i++) {
        const doc = entry.docs[i];
        // Name the file BEFORE the await, so whatever the run is parked on is on screen.
        setProgress((p) => (p ? { ...p, file: doc.relPath, fileNo: i + 1, fileCount: entry.docs.length } : p));
        // Upload FIRST, retire the old row only once the new bytes are verified in the
        // bucket. The reverse order (what the old force-resync did) leaves the quote with
        // no document at all whenever the upload then fails, which on a multi-hundred-job
        // run is a guaranteed way to lose attachments that were merely unopenable before.
        const res = await uploadDocWithRetry(quoteId, doc);
        if (!res.ok) {
          failed++;
          failures.push({
            jobName: entry.jobName,
            relPath: doc.relPath,
            size: doc.size,
            stage: res.stage,
            timedOut: res.timedOut,
            message: res.message,
          });
          // eslint-disable-next-line no-console
          console.warn(`[quote-import] #${entry.index} ${entry.jobName}/${doc.relPath} — ${res.message}`);
          continue;
        }
        uploaded++;
        if (doc.existingDocumentId != null) {
          // Retiring the superseded row is best-effort and must never park the run: a
          // leftover row is a cosmetic duplicate, a hang is a dead import.
          const staleId = doc.existingDocumentId;
          await withDeadline('retiring the old document row', RUN_API_TIMEOUT_MS, () =>
            documentsApi.remove(staleId)
          ).catch(() => undefined);
          // The old object may still be sitting there (or be an orphan metadata row with
          // no bytes — that is what makes a HEAD answer 200 for a dead object). Either
          // way it is unreferenced now.
          if (doc.existingStoragePath) {
            const stalePath = doc.existingStoragePath;
            await withDeadline('deleting the old stored file', RUN_API_TIMEOUT_MS, (signal) =>
              documentsStorage.remove(stalePath, signal)
            ).catch(() => undefined);
          }
          replaced++;
        }
      }

      let linesInserted = 0;
      for (let i = 0; i < entry.linePayloads.length; i++) {
        const payload = entry.linePayloads[i];
        setProgress((p) => (p ? { ...p, file: `line item ${i + 1} of ${entry.linePayloads.length}` } : p));
        try {
          await withDeadline('inserting a line item', RUN_API_TIMEOUT_MS, () => quoteLinesApi.create(quoteId, payload));
          linesInserted++;
        } catch (e: any) {
          failed++;
          failures.push({
            jobName: entry.jobName,
            relPath: '',
            size: null,
            stage: 'line-item',
            timedOut: e instanceof StepTimeoutError,
            message: e?.message || 'Line item insert failed.',
          });
        }
      }

      const allAttempted = entry.docs.length + entry.linePayloads.length;
      const status: EntryStatus = failed === 0 ? 'success' : failed === allAttempted ? 'failed' : 'partial';
      const timedOut = failures.filter((f) => f.timedOut).length;
      setEntry(entry.key, {
        status,
        failures,
        result: { uploaded, failed, linesInserted, timedOut },
        message:
          `${uploaded} uploaded (${replaced} overwritten), ${linesInserted} line item(s) added` +
          (failed
            ? `, ${failed} failed${timedOut ? ` (${timedOut} timed out)` : ''}: ${failures.map(failureLabel).join('; ')}`
            : '') +
          '.',
      });
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));

      // Every item on this job failed — whatever broke it will likely break every
      // remaining job too. Stop now and show the real error instead of grinding
      // through the rest blind (see import log from 2026-10-15: ~465 jobs in a row
      // failed identically with no visibility into why until the whole multi-hour
      // run had already finished).
      if (status === 'failed') {
        setRunError({
          jobName: entry.jobName,
          index: entry.index,
          message: failures.length ? failures.map(failureLabel).join('; ') : 'Unknown error.',
        });
        break;
      }
    }

    setProgress(null);
    setRunning(false);
  };

  const readyCount = entries.filter((e) => e.status === 'ready').length;
  const hasRun = entries.some((e) => e.status === 'success' || e.status === 'partial' || e.status === 'failed');
  const statusCounts = useMemo(() => {
    const counts = {} as Record<EntryStatus, number>;
    (Object.keys(STATUS_LABELS) as EntryStatus[]).forEach((s) => { counts[s] = entries.filter((e) => e.status === s).length; });
    return counts;
  }, [entries]);
  const filteredEntries = useMemo(
    () => entries.filter((e) => statusFilter === 'all' || e.status === statusFilter),
    [entries, statusFilter]
  );

  const facets: ImportFacet[] = [{
    id: 'status',
    value: statusFilter,
    onChange: (v) => setStatusFilter(v as EntryStatus | 'all'),
    allLabel: 'All statuses',
    minWidth: 220,
    options: (Object.keys(STATUS_LABELS) as EntryStatus[]).map((s) => ({ value: s, label: STATUS_LABELS[s], count: statusCounts[s] })),
  }];

  const columns: ImportColumn<Entry>[] = [
    // The run counts jobs off by this number ("Quote 7 of 120"), so a stall is traceable
    // straight back to a row here.
    { header: '#', width: 56, render: (e) => e.index },
    { header: 'Job Folder', width: 260, render: (e) => e.jobName },
    { header: 'Quote', width: 160, render: (e) => (e.quote ? (e.quote.ref_number || `#${e.quote.quote_id}`) : '') },
    {
      header: 'Documents',
      width: 180,
      render: (e) => `${e.docs.filter((d) => d.status === 'replace').length} overwrite, ${e.docs.filter((d) => d.status === 'upload').length} new`,
    },
    {
      header: 'Line Items',
      width: 160,
      render: (e) => (e.linePayloads.length ? `+${e.linePayloads.length} parsed` : e.existingLineCount ? `${e.existingLineCount} present` : 'none'),
    },
    { header: 'Parsed Total', width: 110, render: (e) => (e.parsedTotal != null ? `$${e.parsedTotal.toLocaleString()}` : '') },
    { header: 'Status', width: 140, render: (e) => <StatusChip label={STATUS_LABELS[e.status]} color={STATUS_COLOR[e.status]} /> },
    {
      header: 'Timed Out',
      width: 100,
      render: (e) => {
        const n = e.failures.filter((f) => f.timedOut).length;
        return n ? <StatusChip label={`${n} timed out`} color="warning" /> : '';
      },
    },
    { header: 'Message', render: (e) => e.message },
  ];

  const failureCount = entries.reduce((n, e) => n + e.failures.length, 0);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Pick the folder that holds one subfolder per job (e.g. "2026 Quotes") — every job folder in it is
        planned, and the run is rerunnable any time.
        Every local file is written over the document attached under the same name, no questions asked, so an
        unopenable stored copy is replaced whether or not anything about it looks wrong from the outside.
        Only touches quotes already in the system, and never creates new ones.
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          startIcon={<DriveFolderUploadIcon />}
          onClick={() => folderInputRef.current?.click()}
          disabled={planning || running}
        >
          Choose quotes folder…
        </Button>
        {planning && (
          <Typography variant="body2" color="text.secondary">
            Resolving folder {planningProgress?.done ?? 0} of {planningProgress?.total ?? 0}
            {planningProgress?.jobName ? ` — "${planningProgress.jobName}"` : ''}
            {entries.length ? ` — ${entries.length} planned so far…` : '…'}
          </Typography>
        )}
        {!planning && entries.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            {entries.length} job(s) planned — {readyCount} to overwrite{hasRun ? ', run complete' : ''}.
          </Typography>
        )}
        {!planning && entries.length > 0 && (
          <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadLog(filteredEntries)}>
            Download {statusFilter === 'all' ? 'log' : 'shown'} (CSV)
          </Button>
        )}
        {!planning && failureCount > 0 && (
          <Button size="small" color="error" startIcon={<DownloadIcon />} onClick={() => downloadFailureLog(entries)}>
            Download {failureCount} failed file(s) (CSV)
          </Button>
        )}
        {!planning && entries.length > 0 && (
          <Tooltip title="Writes every local file over the document attached under the same name, with no checking — the stored copy is replaced whether or not anything looks wrong with it. Each upload is verified in the bucket before the old document row is retired, so a failed upload leaves the existing one in place. Documents attached to a quote that have no local counterpart in this folder are left alone.">
            <span>
              <Button variant="contained" color="warning" onClick={() => void runImport()} disabled={running || readyCount === 0}>
                {running ? 'Overwriting…' : `Overwrite ${readyCount} Quote(s)`}
              </Button>
            </span>
          </Tooltip>
        )}
      </Box>
      <input ref={folderInputRef} type="file" hidden multiple onChange={handleFolderChosen} />

      {runError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setRunError(null)}>
          Stopped at #{runError.index} — "{runError.jobName}" failed completely (0 items succeeded): {runError.message}
        </Alert>
      )}

      {planningProgress && (
        <LinearProgress sx={{ mb: 2 }} variant="determinate" value={planningProgress.total ? (planningProgress.done / planningProgress.total) * 100 : 0} />
      )}

      <ImportPanel<Entry>
        rowKey={(e) => e.key}
        rows={filteredEntries}
        totalCount={entries.length}
        filtersActive={statusFilter !== 'all'}
        onClearFilters={() => setStatusFilter('all')}
        facets={facets}
        progress={
          progress
            ? {
                done: progress.done,
                total: progress.total,
                // Names the quote by its row number AND the exact file in flight — the
                // bar standing still then says what it is stuck on, instead of just
                // "7 of 120".
                label:
                  `${progress.done + 1} of ${progress.total} — quote #${progress.index} "${progress.jobName}"` +
                  (progress.file ? ` · file ${progress.fileNo}/${progress.fileCount}: ${progress.file}` : '') +
                  '…',
              }
            : null
        }
        minTableWidth={1500}
        columns={columns}
      />
    </Box>
  );
};

export default QuoteImportPanel;
