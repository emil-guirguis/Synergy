/**
 * Settings > Document Import — bulk-attach a folder tree of scanned documents
 * to their orders. Pick any folder — a grandparent full of customer folders,
 * one customer's folder, or one PO's folder directly. For each file,
 * resolveAncestorPo() walks UP from its immediate parent folder toward the
 * picked root, trying each folder name as a PO number (its underscore-prefix
 * variant too, e.g. "S015523911  _  223 Washington St" -> "S015523911")
 * until one actually matches an order. That means any number of descriptive
 * subfolders under the real PO folder (e.g. ".../S015523911.../5647 Shipping
 * Images/photo.jpg") still land on that PO's order — the PO folder doesn't
 * have to be the file's immediate parent. The folder directly above whichever
 * level resolves is read as the customer name. Each file is classified by
 * name and folder context — see classify()'s own doc comment for the full,
 * priority-ordered rule list — then uploaded to the matched order's
 * Documents tab the same way DocumentsGrid's own "Add Folder" does (bytes
 * straight to the bucket, then the metadata row).
 *
 * The customer folder isn't just cosmetic: a PO number alone can match more
 * than one order (different customers reusing the same PO), so it's used to
 * disambiguate — and two different customer folders that happen to have a
 * same-named PO subfolder are kept as separate groups rather than merged.
 *
 * Picking a folder only builds the PLAN below (every file -> its matched order
 * -> its doc type, or why it won't import) — nothing uploads yet. That plan is
 * downloadable as a log file before Start Import ever runs, so a bad PO match
 * gets caught by eye (or in the CSV) instead of by re-discovering it after the
 * fact. Start Import then walks the same rows and turns each 'ready' one into
 * success/failed in place, so the one table (and one downloadable log) covers
 * both "what will happen" and "what happened".
 *
 * Nothing here is persisted server-side as a "job" — rerunning after fixing a
 * folder name or an order's PO number is just picking the same root folder
 * again. Files already attached (matched by file name on the target order)
 * are detected at plan time and marked 'already', so a rerun only retries
 * what actually failed.
 */
import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import DriveFolderUploadIcon from '@mui/icons-material/DriveFolderUpload';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import {
  DOC_TYPES,
  DOC_TYPE_LABELS,
  formatFileSize,
  storagePathFor,
  type DocType,
  type DocumentRecord,
} from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { ordersService } from '../orders/ordersStore';
import { classifyDocType, isImageFile } from '../../shared/docTypeClassifier';
import type { Order } from '../../types/order';

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const IGNORED_FILE_NAMES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);
const CONCURRENCY = 3;

type OrderMatch = Pick<Order, 'qb_sales_order_id' | 'ref_number' | 'customer_name' | 'po_number'>;

// 'ready'/'already'/'no-match'/'too-large' are plan-time outcomes (known
// before anything uploads); 'success'/'failed' only replace 'ready' once
// Start Import actually runs. There's no blocking "ambiguous" status — a PO
// shared by multiple orders duplicates the file onto each one instead.
type EntryStatus = 'ready' | 'already' | 'no-match' | 'too-large' | 'success' | 'failed';

interface Entry {
  key: string;
  customer: string;
  po: string;
  fileName: string;
  /** Path relative to the folder you picked (e.g. "Import/Acme/S2143242/POD1.pdf")
   *  — browsers never expose a file's true absolute disk path or let a web page
   *  open the OS file explorer, so this relative path (click to copy) is the
   *  closest equivalent available from here. */
  path: string;
  docType: DocType | null;
  status: EntryStatus;
  message: string;
  order: OrderMatch | null;
  file: File;
}

interface FolderGroup {
  /** Every directory segment from the picked root down to (not including) the
   *  filename, e.g. ["ABC","Crawford","Round Rock","S015523911  _  Avalon
   *  Pointe Student Housing","5647 Shipping Images"]. */
  dirParts: string[];
  files: File[];
}

interface AncestorResolution {
  matches: OrderMatch[];
  /** The exact string that produced the match (raw folder name, or its
   *  underscore-prefix variant) — may differ from `po` below. */
  matchedPo: string;
  /** Index into dirParts of the folder that resolved, or -1 if none did. */
  resolvedIdx: number;
  /** Every candidate string actually looked up, in order tried. */
  tried: string[];
}

/**
 * Classify a file — checked in this order, first match wins. The base rules
 * (filename + immediate folder context) live in the shared classifyDocType()
 * so DocumentsGrid's drag-and-drop can reuse the same logic; this layers one
 * more rule on top that only applies here, where the resolved PO is known:
 *   - the file's own name (extension aside) is the same as — or contains —
 *     the resolved PO folder's name (raw, with any "_..." suffix, or the
 *     clean PO number actually matched)                     -> order
 * Checked after the shared rules (which include "starts with PO" / "contains
 * purchase order"), before the image fallback.
 */
function classify(fileName: string, folderPo: string, leafFolder: string, matchedPo: string): DocType {
  const base = classifyDocType(fileName, leafFolder);
  if (base !== 'other') return base;
  const lowerName = fileName.toLowerCase();
  for (const po of [folderPo.trim(), matchedPo.trim()]) {
    if (po && !po.startsWith('(') && lowerName.includes(po.toLowerCase())) return 'order';
  }
  return isImageFile(fileName) ? 'shipping_images' : 'other';
}

/**
 * "_" in a folder name plays two different roles depending on whether it has
 * space around it, and a folder can use both at once (e.g. "MMR_010760  _
 * Beauty of Sight" — tight "_" inside the code, spaced "_" before the site
 * name), so this peels them apart in that order:
 *
 *  1. A "_" WITH space on both sides is the PO/description separator (e.g.
 *     "S2143242 _ Orange Logistics Bldg 2", or a bare trailing "S2143242_").
 *     Splitting there and keeping the left side drops the description (or
 *     the stray trailing underscore) — that becomes `poPart`.
 *  2. A "_" with NO surrounding space, still present in `poPart`, is packed
 *     INSIDE the PO itself, standing in for a "/" a folder name can't
 *     contain (e.g. "MMR_010760" -> "MMR/010760"). Tried as both a tight
 *     and a spaced slash, since po_number is matched exactly past outer
 *     trim. The letter-code prefix ("MMR") might not even be part of the
 *     stored number, so the bare suffix ("010760") is tried too.
 *
 * Raw folder name is tried first (in case it's a literal exact match), so a
 * lookup only falls back to these when the exact folder name matches nothing.
 */
function poLookupVariants(po: string): string[] {
  const trimmed = po.trim();
  const variants = [trimmed];
  const pushIfNew = (v: string) => {
    if (v && !variants.includes(v)) variants.push(v);
  };

  const poPart = trimmed.split(/\s+_\s+/)[0].trim();
  if (poPart !== trimmed) pushIfNew(poPart);

  if (poPart.includes('_')) {
    pushIfNew(poPart.replace(/_/g, '/'));
    pushIfNew(poPart.replace(/_/g, ' / '));
    pushIfNew(poPart.split('_')[0].trim());
    pushIfNew(poPart.split('_').slice(1).join('_').trim());
  }
  return variants;
}

/** The directory portion of a relative path, e.g. "Import/Acme/S2143242/file.pdf" -> "Import/Acme/S2143242". */
function folderOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** Strip punctuation/casing/extra spaces for a lenient customer-name compare. */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Folder name vs. QB customer_name rarely match byte-for-byte — accept either containing the other. */
function customerMatches(orderCustomerName: string | null, folderCustomer: string): boolean {
  const a = normalize(orderCustomerName || '');
  const b = normalize(folderCustomer);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Group files by their exact containing folder (everything but the filename). */
function groupByFolder(files: File[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const file of files) {
    const parts = (file.webkitRelativePath || '').split('/');
    const dirParts = parts.slice(0, -1);
    const key = dirParts.join('/');
    let group = groups.get(key);
    if (!group) {
      group = { dirParts, files: [] };
      groups.set(key, group);
    }
    group.files.push(file);
  }
  return Array.from(groups.values());
}

/**
 * A file's PO folder isn't necessarily its immediate parent — there can be
 * descriptive subfolders in between (e.g. ".../S015523911  _  Avalon Pointe
 * Student Housing/5647 Shipping Images/photo.jpg", where "5647 Shipping
 * Images" is just a category, not a PO). So this walks UP from the file's
 * immediate parent toward the picked root, trying each folder name (and its
 * underscore-prefix variant) as a PO number, and stops at the first one that
 * actually matches an order — everything nested any number of levels under
 * that folder belongs to it. The folder immediately above whichever level
 * resolves is read as the customer name.
 */
async function resolveAncestorPo(
  dirParts: string[],
  lookup: (variant: string) => Promise<OrderMatch[]>
): Promise<AncestorResolution> {
  const tried: string[] = [];
  for (let i = dirParts.length - 1; i >= 0; i--) {
    for (const variant of poLookupVariants(dirParts[i])) {
      tried.push(variant);
      const matches = await lookup(variant);
      if (matches.length > 0) {
        return { matches, matchedPo: variant, resolvedIdx: i, tried };
      }
    }
  }
  return { matches: [], matchedPo: '', resolvedIdx: -1, tried };
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]);
    }
  });
  await Promise.all(lanes);
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `row-${keySeq}`;
}

const STATUS_LABELS: Record<EntryStatus, string> = {
  ready: 'ready to import',
  already: 'already attached',
  'no-match': 'no matching order',
  'too-large': 'too large',
  success: 'imported',
  failed: 'failed',
};

const STATUS_COLOR: Record<EntryStatus, 'success' | 'default' | 'error' | 'warning' | 'info'> = {
  ready: 'info',
  already: 'default',
  'no-match': 'error',
  'too-large': 'error',
  success: 'success',
  failed: 'error',
};

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function downloadCsv(entries: Entry[]): void {
  const header = ['Customer Folder', 'PO Folder', 'File', 'Local Path', 'Type', 'Status', 'Order', 'Message'];
  const lines = [header, ...entries.map((e) => [
    e.customer,
    e.po,
    e.fileName,
    e.path,
    e.docType ? DOC_TYPE_LABELS[e.docType] : '',
    STATUS_LABELS[e.status],
    e.order ? (e.order.ref_number || String(e.order.qb_sales_order_id)) : '',
    e.message,
  ])].map((row) => row.map(csvCell).join(',')).join('\r\n');

  const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `document-import-log-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const DocumentImportPanel: React.FC = () => {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [planningProgress, setPlanningProgress] = useState<{ done: number; total: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<EntryStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<DocType | 'all'>('all');

  React.useEffect(() => {
    const el = folderInputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  // Browsers never hand a web page a file's real absolute disk path, and there's
  // no API for a page to open the OS file explorer — copying this folder's path
  // (relative to the folder you picked) is the closest equivalent available here.
  const copyFolderPath = async (entry: Entry) => {
    try {
      await navigator.clipboard.writeText(folderOf(entry.path));
      setCopiedKey(entry.key);
      setTimeout(() => setCopiedKey((k) => (k === entry.key ? null : k)), 1500);
    } catch {
      // Clipboard permission denied/unavailable — nothing more a web page can do.
    }
  };

  /**
   * Resolve every file to its order/status — no uploads. This IS the log.
   * One folder group's rows land in state as soon as that group is resolved
   * (try/finally around the loop body covers every `continue` path too), so
   * the table fills in live instead of appearing all at once at the end.
   */
  const buildPlan = async (picked: File[]) => {
    setPlanning(true);
    setEntries([]);
    const groups = groupByFolder(picked);
    const rows: Entry[] = [];
    setPlanningProgress({ done: 0, total: groups.length });

    // Existing file names per order, so a rerun after a correction marks the
    // files it already delivered as 'already' instead of planning to redo them.
    const existingByOrder = new Map<string, Set<string>>();
    // A candidate folder name (e.g. "Round Rock") gets tried by every leaf
    // folder under it — cache so it's only actually looked up once.
    const poCache = new Map<string, OrderMatch[]>();
    const lookupPoCached = async (variant: string): Promise<OrderMatch[]> => {
      const key = variant.trim().toLowerCase();
      const cached = poCache.get(key);
      if (cached) return cached;
      const result = await ordersService.lookupByPo(variant);
      poCache.set(key, result);
      return result;
    };

    for (const group of groups) {
      try {
        const fallbackPo = group.dirParts[group.dirParts.length - 1] || '(no PO folder)';

        let resolution: AncestorResolution;
        try {
          resolution = await resolveAncestorPo(group.dirParts, lookupPoCached);
        } catch (e: any) {
          for (const file of group.files) {
            rows.push({
              key: nextKey(), customer: '', po: fallbackPo, fileName: file.name, path: file.webkitRelativePath || file.name, docType: classify(file.name, fallbackPo, fallbackPo, fallbackPo),
              status: 'no-match', message: `PO lookup failed: ${e?.message || 'unknown error'}`, order: null, file,
            });
          }
          continue;
        }

        const { matches, matchedPo, resolvedIdx, tried } = resolution;

        if (resolvedIdx === -1) {
          const uniqueTried = Array.from(new Set(tried));
          const shown = uniqueTried.slice(0, 8);
          const triedNote = shown.length ? ` Tried: "${shown.join('", "')}"${uniqueTried.length > shown.length ? `, +${uniqueTried.length - shown.length} more` : ''}.` : '';
          for (const file of group.files) {
            rows.push({
              key: nextKey(), customer: '', po: fallbackPo, fileName: file.name, path: file.webkitRelativePath || file.name, docType: classify(file.name, fallbackPo, fallbackPo, fallbackPo),
              status: 'no-match',
              message: `No order found for "${group.dirParts.join('/')}".${triedNote}`,
              order: null, file,
            });
          }
          continue;
        }

        // The folder that actually resolved, and the folder directly above it
        // (if any) — used as the PO/customer for every file under this leaf,
        // however many descriptive subfolders sit between that PO folder and
        // where the files actually live.
        const po = group.dirParts[resolvedIdx];
        const customer = resolvedIdx > 0 ? group.dirParts[resolvedIdx - 1] : '';
        const skippedLevels = group.dirParts.length - 1 - resolvedIdx;
        // The file's actual immediate parent — may differ from `po` when
        // descriptive subfolders (e.g. "Shipping Images") sit beneath the
        // resolved PO folder; classify() needs this one for folder-based rules.
        const leafFolder = group.dirParts[group.dirParts.length - 1];

        const resolutionBits: string[] = [];
        if (matchedPo !== po.trim()) resolutionBits.push(`matched via PO "${matchedPo}"`);
        if (skippedLevels > 0) {
          resolutionBits.push(`PO folder is ${skippedLevels} level(s) above this file, via "${group.dirParts.slice(resolvedIdx + 1).join('/')}"`);
        }
        const viaVariantNote = resolutionBits.length ? ` (${resolutionBits.join('; ')})` : '';

        // Same PO can land on more than one order (different customers reusing
        // a number) — the customer folder resolves it when it narrows to one.
        // When it doesn't, the PO is genuinely duplicated across orders, so
        // every file is attached to EACH matching order rather than blocked.
        let candidates = matches;
        let disambiguated = false;
        if (matches.length > 1) {
          const byCustomer = matches.filter((m) => customerMatches(m.customer_name, customer));
          if (byCustomer.length === 1) {
            candidates = byCustomer;
            disambiguated = true;
          }
        }

        const duplicateNote = candidates.length > 1
          ? ` Note: PO "${matchedPo}" is shared by ${candidates.length} orders (${candidates.map((c) => `${c.ref_number || c.qb_sales_order_id} — ${c.customer_name || 'no customer'}`).join('; ')}) — attached to each.`
          : '';

        for (const order of candidates) {
          const entityId = String(order.qb_sales_order_id);
          const mismatchNote = candidates.length === 1 && !disambiguated && customer && !customerMatches(order.customer_name, customer)
            ? ` Note: customer folder "${customer}" doesn't match the order's customer "${order.customer_name ?? 'unknown'}" — verify before relying on this.`
            : '';

          if (!existingByOrder.has(entityId)) {
            const existing: DocumentRecord[] = await documentsApi.list('order', entityId).catch(() => []);
            existingByOrder.set(entityId, new Set(existing.map((d) => d.file_name)));
          }
          const already = existingByOrder.get(entityId)!;

          for (const file of group.files) {
            const docType = classify(file.name, po, leafFolder, matchedPo);
            if (already.has(file.name)) {
              rows.push({
                key: nextKey(), customer, po, fileName: file.name, path: file.webkitRelativePath || file.name, docType,
                status: 'already', message: `Already attached to order ${order.ref_number ?? entityId}.${viaVariantNote}${mismatchNote}${duplicateNote}`, order, file,
              });
            } else if (file.size > MAX_FILE_SIZE) {
              rows.push({
                key: nextKey(), customer, po, fileName: file.name, path: file.webkitRelativePath || file.name, docType,
                status: 'too-large',
                message: `${formatFileSize(file.size)} exceeds the ${formatFileSize(MAX_FILE_SIZE)} limit.`,
                order, file,
              });
            } else {
              rows.push({
                key: nextKey(), customer, po, fileName: file.name, path: file.webkitRelativePath || file.name, docType,
                status: 'ready',
                message: `Will attach to order ${order.ref_number ?? entityId} as ${DOC_TYPE_LABELS[docType]}.${viaVariantNote}${mismatchNote}${duplicateNote}`,
                order, file,
              });
            }
          }
        }
      } finally {
        // Flush this group's rows into state immediately so the table fills
        // in live, rather than jumping from empty to complete at the end.
        setEntries([...rows]);
        setPlanningProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    }

    setPlanningProgress(null);
    setPlanning(false);
  };

  const handleFolderChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!picked.length) return;
    const usable = picked.filter((f) => !f.name.startsWith('.') && !IGNORED_FILE_NAMES.has(f.name));
    void buildPlan(usable);
  };

  const runImport = async () => {
    const ready = entries.filter((e) => e.status === 'ready');
    if (!ready.length) return;
    setRunning(true);
    setProgress({ done: 0, total: ready.length });

    const setEntry = (key: string, patch: Partial<Entry>) =>
      setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));

    await runPool(ready, CONCURRENCY, async (entry) => {
      const order = entry.order!;
      const entityId = String(order.qb_sales_order_id);
      const path = storagePathFor('order', entityId, entry.file.name);
      try {
        await documentsStorage.upload(path, entry.file);
        try {
          await documentsApi.create({
            entityType: 'order',
            entityId,
            fileName: entry.file.name,
            storageBucket: documentsStorage.bucket,
            storagePath: path,
            docType: entry.docType ?? undefined,
          });
        } catch (metaError) {
          await documentsStorage.remove(path).catch(() => undefined);
          throw metaError;
        }
        setEntry(entry.key, { status: 'success', message: `Attached to order ${order.ref_number ?? entityId}.` });
      } catch (err: any) {
        setEntry(entry.key, { status: 'failed', message: err?.message || 'Upload failed.' });
      } finally {
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    });

    setProgress(null);
    setRunning(false);
  };

  const readyCount = entries.filter((e) => e.status === 'ready').length;
  const successCount = entries.filter((e) => e.status === 'success').length;
  const failedCount = entries.filter((e) => e.status === 'failed').length;
  const noMatchCount = entries.filter((e) => e.status === 'no-match').length;
  const tooLargeCount = entries.filter((e) => e.status === 'too-large').length;
  const blockedCount = noMatchCount + tooLargeCount;
  const alreadyCount = entries.filter((e) => e.status === 'already').length;
  const hasRun = successCount + failedCount > 0;

  const statusCounts: Record<EntryStatus, number> = {
    ready: readyCount, already: alreadyCount, 'no-match': noMatchCount,
    'too-large': tooLargeCount, success: successCount, failed: failedCount,
  };
  const typeCounts = useMemo(() => {
    const counts = new Map<DocType, number>();
    for (const e of entries) if (e.docType) counts.set(e.docType, (counts.get(e.docType) ?? 0) + 1);
    return counts;
  }, [entries]);
  const filteredEntries = useMemo(
    () => entries.filter(
      (e) => (statusFilter === 'all' || e.status === statusFilter) && (typeFilter === 'all' || e.docType === typeFilter)
    ),
    [entries, statusFilter, typeFilter]
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          startIcon={<DriveFolderUploadIcon />}
          onClick={() => folderInputRef.current?.click()}
          disabled={planning || running}
        >
          Choose folder…
        </Button>
        {planning && (
          <Typography variant="body2" color="text.secondary">
            Resolving folder {planningProgress?.done ?? 0} of {planningProgress?.total ?? 0}
            {entries.length ? ` — ${entries.length} file(s) planned so far…` : '…'}
          </Typography>
        )}
        {!planning && entries.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            {entries.length} file(s) planned — {readyCount} ready, {alreadyCount} already attached, {blockedCount} need
            fixing{hasRun ? `, ${successCount} imported, ${failedCount} failed` : ''}.
          </Typography>
        )}
        {!planning && entries.length > 0 && (
          <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadCsv(filteredEntries)}>
            Download {statusFilter === 'all' && typeFilter === 'all' ? 'log' : 'shown'} (CSV)
          </Button>
        )}
        {!planning && entries.length > 0 && (
          <Button variant="contained" onClick={() => void runImport()} disabled={running || readyCount === 0}>
            {running ? 'Importing…' : `Start Import (${readyCount})`}
          </Button>
        )}
      </Box>
      <input ref={folderInputRef} type="file" hidden multiple onChange={handleFolderChosen} />

      {entries.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">Filter:</Typography>
          <Select
            size="small"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as EntryStatus | 'all')}
            sx={{ minWidth: 220 }}
          >
            <MenuItem value="all">All statuses ({entries.length})</MenuItem>
            {(Object.keys(STATUS_LABELS) as EntryStatus[]).map((s) => (
              <MenuItem key={s} value={s} disabled={statusCounts[s] === 0}>
                {STATUS_LABELS[s]} ({statusCounts[s]})
              </MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as DocType | 'all')}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="all">All types ({entries.length})</MenuItem>
            {DOC_TYPES.map((t) => (
              <MenuItem key={t} value={t} disabled={!typeCounts.get(t)}>
                {DOC_TYPE_LABELS[t]} ({typeCounts.get(t) ?? 0})
              </MenuItem>
            ))}
          </Select>
          {(statusFilter !== 'all' || typeFilter !== 'all') && (
            <Button size="small" onClick={() => { setStatusFilter('all'); setTypeFilter('all'); }}>
              Clear filters
            </Button>
          )}
          {(statusFilter !== 'all' || typeFilter !== 'all') && (
            <Typography variant="body2" color="text.secondary">
              Showing {filteredEntries.length} of {entries.length}.
            </Typography>
          )}
        </Box>
      )}

      {planningProgress && (
        <LinearProgress
          sx={{ mb: 2 }}
          variant="determinate"
          value={planningProgress.total ? (planningProgress.done / planningProgress.total) * 100 : 0}
        />
      )}

      {progress && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            Importing {progress.done} of {progress.total}…
          </Typography>
          <LinearProgress
            variant="determinate"
            value={progress.total ? (progress.done / progress.total) * 100 : 0}
          />
        </Box>
      )}

      {hasRun && !running && (
        <Alert severity={failedCount ? 'warning' : 'success'} sx={{ mb: 2 }}>
          {successCount} imported, {failedCount} failed.
          {failedCount ? ' Fix the failures, then choose the same folder again — everything already attached is left alone.' : ''}
        </Alert>
      )}

      {entries.length > 0 && (
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 720, overflowX: 'auto' }}>
          <Table
            stickyHeader
            sx={{
              minWidth: 1500,
              tableLayout: 'fixed',
              '& .MuiTableCell-root': { fontSize: '0.9rem', py: 1.25, whiteSpace: 'normal', wordBreak: 'break-word' },
            }}
          >
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600, width: 380 }}>Local Path</TableCell>
                <TableCell sx={{ fontWeight: 600, width: 220 }}>File</TableCell>
                <TableCell sx={{ fontWeight: 600, width: 130 }}>Type</TableCell>
                <TableCell sx={{ fontWeight: 600, width: 150 }}>Status</TableCell>
                <TableCell sx={{ fontWeight: 600, width: 110 }}>Order</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Message</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredEntries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography variant="body2" color="text.secondary">No rows match the current filter.</Typography>
                  </TableCell>
                </TableRow>
              )}
              {filteredEntries.map((entry) => (
                <TableRow key={entry.key} hover>
                  <TableCell>
                    <Tooltip title={copiedKey === entry.key ? 'Copied!' : "Browsers can't open File Explorer directly — click to copy this folder's path"}>
                      <Box
                        onClick={() => void copyFolderPath(entry)}
                        sx={{
                          display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer',
                          color: copiedKey === entry.key ? 'success.main' : 'text.secondary',
                          '&:hover': { color: 'primary.main' },
                        }}
                      >
                        <ContentCopyIcon sx={{ fontSize: 14, flexShrink: 0 }} />
                        <Typography variant="body2" component="span" sx={{ wordBreak: 'break-all' }}>
                          {folderOf(entry.path) || '(root)'}
                        </Typography>
                      </Box>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{entry.fileName}</TableCell>
                  <TableCell>{entry.docType ? DOC_TYPE_LABELS[entry.docType] : ''}</TableCell>
                  <TableCell>
                    <Chip label={STATUS_LABELS[entry.status]} color={STATUS_COLOR[entry.status]} variant="outlined" />
                  </TableCell>
                  <TableCell>{entry.order ? (entry.order.ref_number || entry.order.qb_sales_order_id) : ''}</TableCell>
                  <TableCell>{entry.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
};

export default DocumentImportPanel;
