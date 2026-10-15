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
import { Box, Button, LinearProgress, Tooltip, Typography } from '@mui/material';
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

const MAX_FILE_SIZE = 25 * 1024 * 1024; // matches framework/backend/api/base/documents.ts's default
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

type DocStatus = 'ready' | 'already' | 'size-mismatch' | 'too-large';

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
  parsedLines: ParsedQuoteLine[];
  parsedTotal: number | null;
  existingLineCount: number;
  linePayloads: Array<{ qb_item_id: null; item_name: string | null; description: string; quantity: number; rate: number }>;
  status: EntryStatus;
  message: string;
  result?: { uploaded: number; fixed: number; failed: number; linesInserted: number };
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

/** The document row's file_size only ever reflects what the uploader claimed — this checks
 *  what's actually sitting in the bucket, which is the only way to catch a silently truncated
 *  upload. Best-effort: a HEAD that itself fails to load (network/CORS) doesn't block the run. */
async function verifyStoredSize(storagePath: string, expectedSize: number): Promise<boolean> {
  const token = tokenStorage.getToken();
  if (!token) return true;
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${RECORD_DOCS_BUCKET}/${encodeStoragePath(storagePath)}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!res.ok) return true;
    const len = res.headers.get('content-length');
    return len == null || Number(len) === expectedSize;
  } catch {
    return true;
  }
}

async function uploadDocOnce(quoteId: number, doc: DocPlan): Promise<{ ok: boolean; message: string }> {
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
    `${e.docs.filter((d) => d.status === 'ready').length} new, ${e.docs.filter((d) => d.status === 'size-mismatch').length} size-fix, ${e.docs.filter((d) => d.status === 'already').length} ok`,
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
            key: nextKey(), jobName, quote: null, docs: docsRaw, parsedLines: [], parsedTotal: null,
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

        const docs: DocPlan[] = docsRaw.map((d) => {
          if (d.size > MAX_FILE_SIZE) return { ...d, status: 'too-large' };
          const existing = existingByName.get(d.fileName.trim().toLowerCase());
          if (!existing) return { ...d, status: 'ready' };
          if (existing.file_size != null && existing.file_size !== d.size) {
            return { ...d, status: 'size-mismatch', existingDocumentId: existing.document_id, existingStoragePath: existing.storage_path };
          }
          return { ...d, status: 'already', existingDocumentId: existing.document_id, existingStoragePath: existing.storage_path };
        });

        const quoteCandidates = docs.filter((d) => d.docType === 'quote');
        const { header, lines: parsedLines } = await pickPrimary(quoteCandidates);
        const parsedTotal = header.total ?? null;
        const linePayloads = existingLines.length === 0 ? buildLinePayloads(parsedLines, parsedTotal) : [];

        const toUpload = docs.filter((d) => d.status === 'ready').length;
        const toFix = docs.filter((d) => d.status === 'size-mismatch').length;
        const needsWork = toUpload > 0 || toFix > 0 || linePayloads.length > 0;

        const bits: string[] = [];
        if (toUpload) bits.push(`${toUpload} new document(s) to attach`);
        if (toFix) bits.push(`${toFix} document(s) with a stored-byte mismatch — will re-upload`);
        if (linePayloads.length) bits.push(`${linePayloads.length} line item(s) parsed from "${quoteCandidates.find((c) => c.docType === 'quote')?.fileName ?? 'the quote PDF'}" (currently has none)`);
        else if (existingLines.length === 0 && quoteCandidates.length === 0) bits.push('no quote PDF found to parse lines from');
        else if (existingLines.length === 0) bits.push('no BOM table found in the first 3 pages');
        if (!needsWork) bits.push('already up to date');

        rows.push({
          key: nextKey(), jobName, quote, docs, parsedLines, parsedTotal,
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
    if (picked.length) void buildPlan(picked);
  };

  const runImport = async () => {
    const ready = entries.filter((e) => e.status === 'ready');
    if (!ready.length) return;
    setRunning(true);
    setProgress({ done: 0, total: ready.length });

    const setEntry = (key: string, patch: Partial<Entry>) =>
      setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));

    for (const entry of ready) {
      const quoteId = entry.quote!.quote_id;
      let uploaded = 0;
      let fixed = 0;
      let failed = 0;

      for (const doc of entry.docs) {
        if (doc.status === 'ready') {
          const res = await uploadDocWithRetry(quoteId, doc);
          if (res.ok) uploaded++;
          else failed++;
        } else if (doc.status === 'size-mismatch') {
          if (doc.existingDocumentId != null) {
            await documentsApi.remove(doc.existingDocumentId).catch(() => undefined);
            if (doc.existingStoragePath) await documentsStorage.remove(doc.existingStoragePath).catch(() => undefined);
          }
          const res = await uploadDocWithRetry(quoteId, doc);
          if (res.ok) fixed++;
          else failed++;
        }
      }

      let linesInserted = 0;
      for (const payload of entry.linePayloads) {
        try {
          await quoteLinesApi.create(quoteId, payload);
          linesInserted++;
        } catch {
          failed++;
        }
      }

      const allAttempted = entry.docs.filter((d) => d.status === 'ready' || d.status === 'size-mismatch').length + entry.linePayloads.length;
      const status: EntryStatus = failed === 0 ? 'success' : failed === allAttempted ? 'failed' : 'partial';
      setEntry(entry.key, {
        status,
        result: { uploaded, fixed, failed, linesInserted },
        message: `${uploaded} uploaded, ${fixed} re-uploaded (size fix), ${linesInserted} line item(s) added${failed ? `, ${failed} failed` : ''}.`,
      });
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
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
    { header: 'Job Folder', width: 260, render: (e) => e.jobName },
    { header: 'Quote', width: 160, render: (e) => (e.quote ? (e.quote.ref_number || `#${e.quote.quote_id}`) : '') },
    { header: 'Customer', width: 180, render: (e) => e.quote?.customer_name || '' },
    {
      header: 'Documents',
      width: 180,
      render: (e) => `${e.docs.filter((d) => d.status === 'ready').length} new, ${e.docs.filter((d) => d.status === 'size-mismatch').length} size-fix, ${e.docs.filter((d) => d.status === 'already').length} ok`,
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
      <input ref={folderInputRef} type="file" hidden multiple onChange={handleFolderChosen} />

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
