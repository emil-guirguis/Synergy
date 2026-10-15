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
 *  1. Documents: every local file not yet attached (by file name) gets
 *     uploaded. A file that IS already attached has its reported byte count
 *     re-verified against the actual stored object (a HEAD on the bucket,
 *     not just the document row's file_size column, since that column only
 *     ever reflects what the original uploader *claimed* — this is exactly
 *     how a silently truncated upload survives undetected) — a mismatch
 *     deletes and re-uploads it.
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
import { Alert, Box, Button, LinearProgress, TextField, Tooltip, Typography } from '@mui/material';
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

type DocStatus = 'ready' | 'already' | 'size-mismatch' | 'missing';

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

interface Entry {
  key: string;
  jobName: string;
  quote: QuoteMatch | null;
  docs: DocPlan[];
  /** Every document row this quote actually has right now, not just the ones matched to a
   *  local filename — forceResyncJob wipes all of these, so a resync needs the full list. */
  existingDocs: DocumentRecord[];
  parsedLines: ParsedQuoteLine[];
  parsedTotal: number | null;
  existingLineCount: number;
  linePayloads: Array<{ qb_item_id: null; item_name: string | null; description: string; quantity: number; rate: number }>;
  status: EntryStatus;
  message: string;
  result?: { uploaded: number; failed: number; linesInserted: number };
}

const STATUS_LABELS: Record<EntryStatus, string> = {
  'no-match': 'no matching quote',
  'up-to-date': 'up to date',
  ready: 'needs fixing',
  success: 'fixed',
  partial: 'partially fixed',
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

type StoredObjectCheck =
  | { status: 'found'; size: number }
  | { status: 'missing' } // confirmed 404 — the object genuinely isn't in the bucket
  | { status: 'unknown' }; // couldn't tell (no token/network/CORS/timeout/no Content-Length)

/** The document row's file_size only ever reflects what the uploader claimed (originally
 *  the bulk CLI importer's fs.statSync) — this checks what's actually sitting in the
 *  bucket right now, the only ground truth for whether a stored object is really bad.
 *  Distinguishes a confirmed-missing object (404 — e.g. the upload never actually landed,
 *  or got deleted later) from "couldn't check" (network blip) — only the former is reliable
 *  enough to drive an automatic re-upload; callers fall back to the DB column on 'unknown'
 *  rather than treating "couldn't check" as "bad". Hard-timed out: a plan over hundreds of
 *  jobs awaits this per-document, and a single HEAD that never resolves would otherwise
 *  hang the whole run at whichever job hit it. */
async function checkStoredObject(storagePath: string): Promise<StoredObjectCheck> {
  const token = tokenStorage.getToken();
  if (!token) return { status: 'unknown' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORED_SIZE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${RECORD_DOCS_BUCKET}/${encodeStoragePath(storagePath)}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      signal: controller.signal,
    });
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'unknown' };
    const len = res.headers.get('content-length');
    return len == null ? { status: 'unknown' } : { status: 'found', size: Number(len) };
  } catch {
    return { status: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort: a check that couldn't be answered doesn't block the run — but a confirmed
 *  404 right after an upload we just made IS a reliable "no, it didn't take" signal. */
async function verifyStoredSize(storagePath: string, expectedSize: number): Promise<boolean> {
  const check = await checkStoredObject(storagePath);
  if (check.status === 'found') return check.size === expectedSize;
  return check.status !== 'missing';
}

// framework/backend/api/base/documents.ts's DEFAULT_MAX_FILE_SIZE — the Worker rejects the
// metadata insert above this regardless of what the frontend does, but only AFTER the raw
// bytes already landed in storage (that part bypasses the Worker entirely). Checking here
// first fails fast with a clear reason instead of wasting the upload and surfacing a vague
// error — and, critically, still shows up as a real logged failure rather than being
// silently excluded from the plan the way the old 'too-large' status used to.
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

async function uploadDocOnce(quoteId: number, doc: DocPlan): Promise<{ ok: boolean; message: string }> {
  if (doc.size > MAX_UPLOAD_SIZE) {
    return {
      ok: false,
      message: `File too large to attach (${formatFileSize(doc.size)} exceeds the ${formatFileSize(MAX_UPLOAD_SIZE)} limit) — not uploaded.`,
    };
  }
  const path = storagePathFor('quote', String(quoteId), doc.fileName);
  try {
    await documentsStorage.upload(path, doc.file);
    const sizeOk = await verifyStoredSize(path, doc.size);
    if (!sizeOk) {
      await documentsStorage.remove(path).catch(() => undefined);
      return { ok: false, message: `Uploaded bytes didn't match the local file (${formatFileSize(doc.size)}).` };
    }
    await documentsApi.create({
      entityType: 'quote',
      entityId: String(quoteId),
      fileName: doc.fileName,
      storageBucket: RECORD_DOCS_BUCKET,
      storagePath: path,
      docType: doc.docType,
      mimeType: mimeFor(doc.file),
      fileSize: doc.size,
    });
    return { ok: true, message: 'Uploaded.' };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'Upload failed.' };
  }
}

/** One retry on a verified size mismatch or a transient upload error — a 4xx validation
 *  error (bad path, oversized file) would just fail the same way twice, but a truncated
 *  transfer often doesn't repeat. */
async function uploadDocWithRetry(quoteId: number, doc: DocPlan): Promise<{ ok: boolean; message: string }> {
  const first = await uploadDocOnce(quoteId, doc);
  if (first.ok) return first;
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

function downloadLog(entries: Entry[]): void {
  const header = ['Job', 'Quote', 'Customer', 'Documents', 'Line Items', 'Parsed Total', 'Status', 'Message'];
  const rows = entries.map((e) => [
    e.jobName,
    e.quote?.ref_number || '',
    e.quote?.customer_name || '',
    `${e.docs.filter((d) => d.status === 'ready').length} new, ${e.docs.filter((d) => d.status === 'missing').length} missing, ${e.docs.filter((d) => d.status === 'size-mismatch').length} size-differs, ${e.docs.filter((d) => d.status === 'already').length} ok`,
    e.linePayloads.length ? `${e.linePayloads.length} to insert` : e.existingLineCount ? `${e.existingLineCount} already present` : 'none found',
    e.parsedTotal != null ? String(e.parsedTotal) : '',
    STATUS_LABELS[e.status],
    e.message,
  ]);
  downloadCsv('quote-import-log', header, rows);
}

export const QuoteImportPanel: React.FC = () => {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [planningProgress, setPlanningProgress] = useState<{ done: number; total: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [statusFilter, setStatusFilter] = useState<EntryStatus | 'all'>('all');
  const [runError, setRunError] = useState<{ jobName: string; message: string } | null>(null);
  const [resyncLimit, setResyncLimit] = useState(30);

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
    setPlanningProgress({ done: 0, total: groups.size });

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
      try {
        const quote = quoteByJobName.get(normalize(jobName)) ?? null;
        const docsRaw: DocPlan[] = files.map(({ relPath, file }) => ({
          relPath,
          fileName: relPath.split('/').pop() || relPath,
          file,
          size: file.size,
          docType: classifyQuoteFile(relPath),
          status: 'ready',
        }));

        if (!quote) {
          rows.push({
            key: nextKey(), jobName, quote: null, docs: docsRaw, existingDocs: [], parsedLines: [], parsedTotal: null,
            existingLineCount: 0, linePayloads: [], status: 'no-match',
            message: `No existing quote with job_name matching "${jobName}" — this tool only fixes quotes already in the system, never creates new ones.`,
          });
          continue;
        }

        const [existingDocs, existingLines] = await Promise.all([
          documentsApi.list('quote', String(quote.quote_id)).catch(() => [] as DocumentRecord[]),
          quoteLinesApi.list(quote.quote_id).catch(() => [] as any[]),
        ]);
        const existingByName = new Map(existingDocs.map((d) => [d.file_name.trim().toLowerCase(), d]));

        // Trust the real stored bytes over the DB's file_size column — the original bulk
        // importer wrote that column from a local fs.statSync at CLI-import time, and
        // plenty of those have drifted from what's actually in the bucket without the
        // bucket object itself being wrong. Comparing against the column alone flagged
        // nearly everything as a "mismatch" even though most of those files opened fine.
        const docs: DocPlan[] = await Promise.all(docsRaw.map(async (d) => {
          const existing = existingByName.get(d.fileName.trim().toLowerCase());
          if (!existing) return { ...d, status: 'ready' as DocStatus };
          if (!existing.storage_path) {
            return { ...d, status: 'missing' as DocStatus, existingDocumentId: existing.document_id, existingStoragePath: null };
          }
          const check = await checkStoredObject(existing.storage_path);
          if (check.status === 'missing') {
            return { ...d, status: 'missing' as DocStatus, existingDocumentId: existing.document_id, existingStoragePath: existing.storage_path };
          }
          const referenceSize = check.status === 'found' ? check.size : existing.file_size;
          if (referenceSize != null && referenceSize !== d.size) {
            return { ...d, status: 'size-mismatch' as DocStatus, existingDocumentId: existing.document_id, existingStoragePath: existing.storage_path };
          }
          return { ...d, status: 'already' as DocStatus, existingDocumentId: existing.document_id, existingStoragePath: existing.storage_path };
        }));

        const quoteCandidates = docs.filter((d) => d.docType === 'quote');
        const { header, lines: parsedLines } = await pickPrimary(quoteCandidates);
        const parsedTotal = header.total ?? null;
        const linePayloads = existingLines.length === 0 ? buildLinePayloads(parsedLines, parsedTotal) : [];

        const toUpload = docs.filter((d) => d.status === 'ready').length;
        // Confirmed-missing (404 on the actual bucket object) is a hard signal — always
        // re-upload. Size-mismatch is informational only — a different byte count than
        // your local copy doesn't by itself mean the stored file is broken (most still
        // open fine), so it no longer queues an automatic delete-and-reupload on its own.
        const toReupload = docs.filter((d) => d.status === 'missing').length;
        const toFix = docs.filter((d) => d.status === 'size-mismatch').length;
        const needsWork = toUpload > 0 || toReupload > 0 || linePayloads.length > 0;

        const bits: string[] = [];
        if (toUpload) bits.push(`${toUpload} new document(s) to attach`);
        if (toReupload) bits.push(`${toReupload} document(s) missing from storage — will re-upload`);
        if (toFix) bits.push(`${toFix} document(s) have a different stored byte count than your local copy — not necessarily broken, review manually`);
        if (linePayloads.length) bits.push(`${linePayloads.length} line item(s) parsed from "${quoteCandidates.find((c) => c.docType === 'quote')?.fileName ?? 'the quote PDF'}" (currently has none)`);
        else if (existingLines.length === 0 && quoteCandidates.length === 0) bits.push('no quote PDF found to parse lines from');
        else if (existingLines.length === 0) bits.push('no BOM table found in the first 3 pages');
        if (!needsWork) bits.push('already up to date');

        rows.push({
          key: nextKey(), jobName, quote, docs, existingDocs, parsedLines, parsedTotal,
          existingLineCount: existingLines.length, linePayloads,
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
    setProgress({ done: 0, total: ready.length });

    const setEntry = (key: string, patch: Partial<Entry>) =>
      setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));

    for (const entry of ready) {
      const quoteId = entry.quote!.quote_id;
      let uploaded = 0;
      let failed = 0;
      let lastErrorMessage: string | null = null;

      for (const doc of entry.docs) {
        if (doc.status === 'ready' || doc.status === 'missing') {
          if (doc.status === 'missing' && doc.existingDocumentId != null) {
            // Object already confirmed gone (404) — nothing to remove from storage,
            // just drop the stale row before writing the fresh one.
            await documentsApi.remove(doc.existingDocumentId).catch(() => undefined);
          }
          const res = await uploadDocWithRetry(quoteId, doc);
          if (res.ok) uploaded++;
          else { failed++; lastErrorMessage = res.message; }
        }
      }

      let linesInserted = 0;
      for (const payload of entry.linePayloads) {
        try {
          await quoteLinesApi.create(quoteId, payload);
          linesInserted++;
        } catch (e: any) {
          failed++;
          lastErrorMessage = e?.message || 'Line item insert failed.';
        }
      }

      const allAttempted = entry.docs.filter((d) => d.status === 'ready' || d.status === 'missing').length + entry.linePayloads.length;
      const status: EntryStatus = failed === 0 ? 'success' : failed === allAttempted ? 'failed' : 'partial';
      setEntry(entry.key, {
        status,
        result: { uploaded, failed, linesInserted },
        message: `${uploaded} uploaded, ${linesInserted} line item(s) added${failed ? `, ${failed} failed${lastErrorMessage ? `: ${lastErrorMessage}` : ''}` : ''}.`,
      });
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));

      // Every item on this job failed — whatever broke it will likely break every
      // remaining job too. Stop now and show the real error instead of grinding
      // through the rest blind (see import log from 2026-10-15: ~465 jobs in a row
      // failed identically with no visibility into why until the whole multi-hour
      // run had already finished).
      if (status === 'failed') {
        setRunError({ jobName: entry.jobName, message: lastErrorMessage || 'Unknown error.' });
        break;
      }
    }

    setProgress(null);
    setRunning(false);
  };

  /** Bypasses every detection heuristic above — HEAD-based checks have twice now
   *  disagreed with reality (stale file_size column, then a HEAD that reports a stored
   *  object "found" while the actual download 404s — Villa Hermosa, 2026-10-15, likely
   *  the known Supabase region-migration RLS gap on storage.objects). Deletes every
   *  document row + storage object this quote currently has, then re-uploads every local
   *  file fresh. No diffing, no guessing — whatever's wrong, this always ends in the same
   *  known-good state. Destructive: any remote document with no local counterpart in this
   *  folder is gone for good, which is why this runs on a capped batch first. */
  const runForceResync = async (limit: number) => {
    const targets = entries.filter((e) => e.quote != null).slice(0, limit);
    if (!targets.length) return;
    setRunning(true);
    setRunError(null);
    setProgress({ done: 0, total: targets.length });

    const setEntry = (key: string, patch: Partial<Entry>) =>
      setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));

    for (const entry of targets) {
      const quoteId = entry.quote!.quote_id;
      let removed = 0;
      let uploaded = 0;
      let failed = 0;
      let lastErrorMessage: string | null = null;

      for (const doc of entry.existingDocs) {
        await documentsApi.remove(doc.document_id).catch(() => undefined);
        if (doc.storage_path) await documentsStorage.remove(doc.storage_path).catch(() => undefined);
        removed++;
      }

      for (const doc of entry.docs) {
        const res = await uploadDocWithRetry(quoteId, doc);
        if (res.ok) uploaded++;
        else { failed++; lastErrorMessage = res.message; }
      }

      const allAttempted = entry.docs.length;
      const status: EntryStatus = failed === 0 ? 'success' : failed === allAttempted ? 'failed' : 'partial';
      setEntry(entry.key, {
        status,
        result: { uploaded, failed, linesInserted: 0 },
        message: `Resynced: removed ${removed} old doc(s), uploaded ${uploaded} fresh${failed ? `, ${failed} failed${lastErrorMessage ? `: ${lastErrorMessage}` : ''}` : ''}.`,
      });
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));

      if (status === 'failed') {
        setRunError({ jobName: entry.jobName, message: lastErrorMessage || 'Unknown error.' });
        break;
      }
    }

    setProgress(null);
    setRunning(false);
  };

  const readyCount = entries.filter((e) => e.status === 'ready').length;
  const matchedCount = entries.filter((e) => e.quote != null).length;
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
    { header: 'Job Folder', width: 260, render: (e) => e.jobName },
    { header: 'Quote', width: 160, render: (e) => (e.quote ? (e.quote.ref_number || `#${e.quote.quote_id}`) : '') },
    { header: 'Customer', width: 180, render: (e) => e.quote?.customer_name || '' },
    {
      header: 'Documents',
      width: 180,
      render: (e) => `${e.docs.filter((d) => d.status === 'ready').length} new, ${e.docs.filter((d) => d.status === 'missing').length} missing, ${e.docs.filter((d) => d.status === 'size-mismatch').length} size-differs, ${e.docs.filter((d) => d.status === 'already').length} ok`,
    },
    {
      header: 'Line Items',
      width: 160,
      render: (e) => (e.linePayloads.length ? `+${e.linePayloads.length} parsed` : e.existingLineCount ? `${e.existingLineCount} present` : 'none'),
    },
    { header: 'Parsed Total', width: 110, render: (e) => (e.parsedTotal != null ? `$${e.parsedTotal.toLocaleString()}` : '') },
    { header: 'Status', width: 140, render: (e) => <StatusChip label={STATUS_LABELS[e.status]} color={STATUS_COLOR[e.status]} /> },
    { header: 'Message', render: (e) => e.message },
  ];

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Pick the folder that holds one subfolder per job (e.g. "2026 Quotes") — rerunnable any time;
        only fixes quotes already in the system (missing/corrupt documents, missing line items, missing totals), never creates new ones.
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
            {entries.length ? ` — ${entries.length} planned so far…` : '…'}
          </Typography>
        )}
        {!planning && entries.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            {entries.length} job(s) planned — {readyCount} need fixing{hasRun ? ', run complete' : ''}.
          </Typography>
        )}
        {!planning && entries.length > 0 && (
          <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadLog(filteredEntries)}>
            Download {statusFilter === 'all' ? 'log' : 'shown'} (CSV)
          </Button>
        )}
        {!planning && entries.length > 0 && (
          <Tooltip title="Only acts on rows marked 'needs fixing' — matched quotes already up to date are left alone.">
            <span>
              <Button variant="contained" onClick={() => void runImport()} disabled={running || readyCount === 0}>
                {running ? 'Fixing…' : `Fix ${readyCount} Quote(s)`}
              </Button>
            </span>
          </Tooltip>
        )}
      </Box>
      {!planning && matchedCount > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
          <Tooltip title="Bypasses all detection above. Deletes EVERY document row and storage object this quote currently has — even ones with no local counterpart in this folder — then re-uploads every local file fresh. No diffing, no guessing. Validate on a small batch before running it on everything.">
            <span>
              <TextField
                size="small"
                type="number"
                label="Batch size"
                value={resyncLimit}
                onChange={(e) => setResyncLimit(Math.max(1, Number(e.target.value) || 1))}
                disabled={running}
                sx={{ width: 110 }}
              />
            </span>
          </Tooltip>
          <Button
            color="warning"
            variant="outlined"
            onClick={() => void runForceResync(resyncLimit)}
            disabled={running || matchedCount === 0}
          >
            {running ? 'Resyncing…' : `Force resync first ${Math.min(resyncLimit, matchedCount)} of ${matchedCount}`}
          </Button>
          <Button
            color="warning"
            variant="text"
            onClick={() => void runForceResync(matchedCount)}
            disabled={running || matchedCount === 0}
          >
            Force resync all {matchedCount} matched
          </Button>
        </Box>
      )}
      <input ref={folderInputRef} type="file" hidden multiple onChange={handleFolderChosen} />

      {runError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setRunError(null)}>
          Stopped — "{runError.jobName}" failed completely (0 items succeeded): {runError.message}
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
        progress={progress ? { done: progress.done, total: progress.total, label: `Fixing ${progress.done} of ${progress.total}…` } : null}
        minTableWidth={1400}
        columns={columns}
      />
    </Box>
  );
};

export default QuoteImportPanel;
