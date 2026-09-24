/**
 * Settings > Commission Import — bulk-update order financial/build fields from
 * the rep-maintained "TBWC & Dent Build List.xlsx" workbook (see memory
 * tbwc-orders-spreadsheet-mapping for the column map this mirrors). Parses the
 * workbook client-side (SheetJS), matches each row to an order, diffs it
 * against what's already stored, and stages everything for review before any
 * write happens — same plan-then-push shape as Settings > Document Import
 * (DocumentImportPanel.tsx): picking the file only builds the table below,
 * nothing is written until Start Import runs.
 *
 * Sheets are read in this fixed priority order — 2026, 2025, 2024, then
 * Consignment — and each order is claimed by whichever sheet resolves it
 * first. A later (lower-priority) sheet's row for an already-claimed order is
 * marked 'superseded' rather than overwriting it: newest year wins on a
 * duplicate, per the same order appearing in more than one tab.
 *
 * The 2026/2025/2024 tabs key off column "TBWC#" (ref_number, exact match).
 * "Consignment Orders" has no TBWC# column at all — it keys off "PO#" instead,
 * which (like Document Import's PO lookup) can match more than one order; the
 * sheet's own customer column narrows it the same way a folder name does
 * there, and an unresolved tie is left 'ambiguous' rather than guessed.
 *
 * Column headers differ slightly between tabs (2026 adds "SHIP NLT", 2024 uses
 * a different layout entirely) — see spreadsheet-column-mapping-verify-exact
 * memory for why this resolves every field by its exact header TEXT per sheet
 * (FIELD_DEFS below), never by a fixed column letter/position. A field whose
 * header isn't present on a given sheet is simply not sourced from that sheet.
 *
 * A blank cell means "no opinion, don't touch the existing value" for every
 * text/currency/date field — it's never written as an overwrite-to-null. The
 * two checkbox-style flags (EXP/JAY) are the one exception: the sheet only
 * ever marks them with a literal "x" or leaves them blank, so blank there is
 * read as an authoritative "false" when that column exists on the sheet.
 */
import React, { useRef, useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
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
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import { ordersService } from '../orders/ordersStore';
import type { Order, OrderImportIndexRow } from '../../types/order';

type FieldKind = 'text' | 'currency' | 'boolean' | 'date';

interface FieldDef {
  dbField: keyof Order & keyof OrderImportIndexRow;
  label: string;
  headers: string[];
  kind: FieldKind;
}

// The full TBWC-owned set from the sheet, per tbwc-orders-spreadsheet-mapping.
// "JAY TER" (2024's column) is deliberately NOT listed as an alias for JAY —
// different header text, not proven to mean the same thing.
const FIELD_DEFS: FieldDef[] = [
  { dbField: 'build_notes', label: 'Build Notes', headers: ['BUILD NOTES'], kind: 'text' },
  { dbField: 'expedite', label: 'Expedite', headers: ['EXP'], kind: 'boolean' },
  { dbField: 'jay', label: 'Jay', headers: ['JAY'], kind: 'boolean' },
  { dbField: 'notes', label: 'Notes', headers: ['NOTES'], kind: 'text' },
  { dbField: 'job_name', label: 'Job Name', headers: ['JOB NAME'], kind: 'text' },
  { dbField: 'ship_no_later_than', label: 'Ship NLT', headers: ['SHIP NLT'], kind: 'date' },
  { dbField: 'd_net_cost', label: 'D-Net Cost', headers: ['DNC'], kind: 'currency' },
  { dbField: 'sold_for', label: 'Sold For', headers: ['SOLD FOR'], kind: 'currency' },
  { dbField: 'commission', label: 'Commission', headers: ['COMM 15%'], kind: 'currency' },
  { dbField: 'overage', label: 'Overage', headers: ['OVG 75/25'], kind: 'currency' },
  { dbField: 'project_admin_fee', label: 'Proj Admin Fee', headers: ['PROJ ADM'], kind: 'currency' },
  { dbField: 'trade_ally_fee', label: 'Trade Ally Fee', headers: ['Trade Ally'], kind: 'currency' },
];

const CUSTOMER_HEADERS = ['CUSTOMER', 'CUSTOMERS', 'CUSTOMER+'];
const REF_HEADER = 'TBWC#';
const PO_HEADER = 'PO#';
const COMM_TOTAL_HEADER = 'COMM TOTAL';

// Priority order = dedupe order: an order already claimed by an earlier sheet
// here is never touched by a later one.
const SHEETS: { name: string; keyBy: 'ref' | 'po' }[] = [
  { name: '2026 Orders', keyBy: 'ref' },
  { name: '2025 Orders', keyBy: 'ref' },
  { name: '2024 Orders', keyBy: 'ref' },
  { name: 'Consignment Orders', keyBy: 'po' },
];

const CONCURRENCY = 5;

type RowStatus = 'ready' | 'no-change' | 'no-match' | 'ambiguous' | 'superseded' | 'success' | 'failed';

interface DiffField {
  def: FieldDef;
  from: string;
  to: string;
  value: string | number | boolean | null;
}

interface StagedRow {
  key: string;
  sheet: string;
  rowNum: number;
  keyType: 'ref' | 'po';
  keyValue: string;
  customerSheet: string;
  order: { qb_sales_order_id: number; ref_number: string | null; po_number: string | null; customer_name: string | null } | null;
  diffs: DiffField[];
  status: RowStatus;
  message: string;
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `row-${keySeq}`;
}

const STATUS_LABELS: Record<RowStatus, string> = {
  ready: 'ready to import',
  'no-change': 'no change',
  'no-match': 'no matching order',
  ambiguous: 'ambiguous PO',
  superseded: 'superseded by newer sheet',
  success: 'imported',
  failed: 'failed',
};

const STATUS_COLOR: Record<RowStatus, 'success' | 'default' | 'error' | 'warning' | 'info'> = {
  ready: 'info',
  'no-change': 'default',
  'no-match': 'error',
  ambiguous: 'warning',
  superseded: 'default',
  success: 'success',
  failed: 'error',
};

const formatCurrency = (n: number | null | undefined): string =>
  n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);

/** Strip punctuation/casing/extra spaces for a lenient customer-name compare. */
function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Sheet's customer text vs. QB customer_name rarely match byte-for-byte. */
function customerMatches(orderCustomerName: string | null, sheetCustomer: string): boolean {
  const a = normalizeName(orderCustomerName || '');
  const b = normalizeName(sheetCustomer);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * One build-list row occasionally covers two orders shipped together, noted
 * as e.g. "TBWC5211/12" — shorthand for TBWC 5211 and TBWC 5212, the second
 * number written as just its differing trailing digits. Returns both full
 * ref strings ("TBWC 5211", "TBWC 5212"), or null if the key isn't shaped
 * like that. The caller still looks each one up for real — this only expands
 * the shorthand, it doesn't assume either order exists.
 */
function splitCompoundRef(raw: string): string[] | null {
  const m = raw.match(/^TBWC\s*(\d+)\s*\/\s*(\d+)$/i);
  if (!m) return null;
  const [, first, second] = m;
  const secondFull = second.length >= first.length ? second : first.slice(0, first.length - second.length) + second;
  return [`TBWC ${first}`, `TBWC ${secondFull}`];
}

/** Formats a cell for display/diff: numbers to 2dp text, dates to YYYY-MM-DD, else trimmed string. */
function displayValue(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return dateToIso(v);
  if (typeof v === 'number') return v.toFixed(2);
  return String(v).trim();
}

/** Local-date components only — avoids the UTC-shift toISOString() would apply to a sheet's local date. */
function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Header row -> column index, keyed by trimmed/uppercased header text (exact match only, see file doc comment). */
function headerIndex(headerRow: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  headerRow.forEach((h, i) => {
    if (h == null) return;
    const key = String(h).trim().toUpperCase();
    if (key && !map.has(key)) map.set(key, i);
  });
  return map;
}

function findColumn(headers: Map<string, number>, candidates: string[]): number | undefined {
  for (const c of candidates) {
    const idx = headers.get(c.toUpperCase());
    if (idx !== undefined) return idx;
  }
  return undefined;
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

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function downloadCsv(entries: StagedRow[]): void {
  const header = ['Sheet', 'Row', 'Key Type', 'Key', 'Customer (sheet)', 'Order', 'Status', 'Changes', 'Message'];
  const lines = [header, ...entries.map((e) => [
    e.sheet,
    String(e.rowNum),
    e.keyType,
    e.keyValue,
    e.customerSheet,
    e.order ? (e.order.ref_number || String(e.order.qb_sales_order_id)) : '',
    STATUS_LABELS[e.status],
    e.diffs.map((d) => `${d.def.label}: ${d.from || '(blank)'} -> ${d.to}`).join('; '),
    e.message,
  ])].map((row) => row.map(csvCell).join(',')).join('\r\n');

  const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `commission-import-log-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const CommissionImportPanel: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [entries, setEntries] = useState<StagedRow[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RowStatus | 'all'>('all');
  const [sheetFilter, setSheetFilter] = useState<string | 'all'>('all');

  const buildPlan = async (file: File) => {
    setPlanning(true);
    setPlanError(null);
    setEntries([]);
    const rows: StagedRow[] = [];

    try {
      const [buf, index] = await Promise.all([file.arrayBuffer(), ordersService.importIndex()]);
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });

      const byRef = new Map<string, OrderImportIndexRow[]>();
      const byPo = new Map<string, OrderImportIndexRow[]>();
      for (const o of index) {
        const ref = (o.ref_number || '').trim().toLowerCase();
        if (ref) byRef.set(ref, [...(byRef.get(ref) || []), o]);
        const po = (o.po_number || '').trim().toLowerCase();
        if (po) byPo.set(po, [...(byPo.get(po) || []), o]);
      }

      // Which order id has already been claimed by a higher-priority sheet —
      // this is the newest-year-wins dedupe.
      const claimed = new Map<number, string>();

      for (const { name, keyBy } of SHEETS) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null }) as unknown[][];
        if (grid.length < 2) continue;
        const headers = headerIndex(grid[0]);

        const refCol = findColumn(headers, [REF_HEADER]);
        const poCol = findColumn(headers, [PO_HEADER]);
        const custCol = findColumn(headers, CUSTOMER_HEADERS) ?? 0; // sheets with no recognized header still have customer in col A
        const commTotalCol = findColumn(headers, [COMM_TOTAL_HEADER]);
        const commCol = findColumn(headers, ['COMM 15%']);
        const ovgCol = findColumn(headers, ['OVG 75/25']);

        const fieldCols = FIELD_DEFS.map((def) => ({ def, col: findColumn(headers, def.headers) }))
          .filter((f): f is { def: FieldDef; col: number } => f.col !== undefined);

        for (let r = 1; r < grid.length; r++) {
          const row = grid[r];
          const excelRow = r + 1;
          const keyCol = keyBy === 'ref' ? refCol : poCol;
          if (keyCol === undefined) break; // sheet has no key column at all — nothing to do here
          const rawKey = row[keyCol];
          const keyValue = rawKey == null ? '' : String(rawKey).trim();
          if (!keyValue) continue; // blank row — not real data

          const customerSheet = row[custCol] == null ? '' : String(row[custCol]).trim();
          const map = keyBy === 'ref' ? byRef : byPo;
          let candidates = map.get(keyValue.toLowerCase()) || [];

          if (candidates.length > 1 && customerSheet) {
            const byCust = candidates.filter((o) => customerMatches(o.customer_name, customerSheet));
            if (byCust.length === 1) candidates = byCust;
          }

          const base = { sheet: name, rowNum: excelRow, keyType: keyBy, keyValue, customerSheet };

          // A miss on the exact key gets one more try: "TBWC5211/12" shorthand
          // for two orders shipped together on one build-list row (see
          // splitCompoundRef). Ambiguous (candidates.length > 1, e.g. the
          // several real orders literally named ref_number "Direct Ship") is
          // NOT retried here — that's a data problem, not a shorthand to expand.
          let resolvedOrders = candidates;
          let compoundNote = '';
          if (resolvedOrders.length === 0 && keyBy === 'ref') {
            const expanded = splitCompoundRef(keyValue);
            if (expanded) {
              // Each expanded ref gets the same customer-column narrowing the
              // direct-match path gets above — a compound row's ref_number can
              // itself be shared by more than one order (seen for real: two
              // "TBWC 5211" rows in QB, disambiguated only by customer).
              const perRef = expanded.map((ref) => {
                let m = byRef.get(ref.toLowerCase()) || [];
                if (m.length > 1 && customerSheet) {
                  const byCust = m.filter((o) => customerMatches(o.customer_name, customerSheet));
                  if (byCust.length === 1) m = byCust;
                }
                return { ref, matches: m };
              });
              const found = perRef.filter((p) => p.matches.length === 1).map((p) => p.matches[0]);
              const stillAmbiguous = perRef.filter((p) => p.matches.length > 1);
              const uniq = Array.from(new Map(found.map((o) => [o.qb_sales_order_id, o])).values());
              if (uniq.length > 0) {
                resolvedOrders = uniq;
                const ambigNote = stillAmbiguous.length
                  ? ` (${stillAmbiguous.map((p) => `${p.ref} still matches ${p.matches.length} orders, not staged`).join('; ')})`
                  : '';
                compoundNote = `Compound key — split "${keyValue}" into ${expanded.join(' / ')} (${uniq.length} of 2 found${ambigNote}). `
                  + (uniq.length > 1 ? 'Same sheet values staged for each — verify whether $ amounts should be divided between them before importing. ' : '');
              } else {
                rows.push({ ...base, key: nextKey(), order: null, diffs: [], status: 'no-match', message: `No order found for TBWC# "${keyValue}". Tried compound split: ${expanded.join(', ')} — neither found.` });
                continue;
              }
            }
          }

          if (resolvedOrders.length === 0) {
            rows.push({ ...base, key: nextKey(), order: null, diffs: [], status: 'no-match', message: `No order found for ${keyBy === 'ref' ? 'TBWC#' : 'PO#'} "${keyValue}".` });
            continue;
          }
          if (resolvedOrders.length > 1 && !compoundNote) {
            rows.push({
              ...base, key: nextKey(), order: null, diffs: [], status: 'ambiguous',
              message: `${keyBy === 'ref' ? 'TBWC#' : 'PO#'} "${keyValue}" matches ${resolvedOrders.length} orders and the customer column didn't narrow it: ${resolvedOrders.map((c) => c.ref_number || c.qb_sales_order_id).join(', ')}.`,
            });
            continue;
          }

          for (const order of resolvedOrders) {
            const orderRef = { qb_sales_order_id: order.qb_sales_order_id, ref_number: order.ref_number, po_number: order.po_number, customer_name: order.customer_name };

            if (claimed.has(order.qb_sales_order_id)) {
              rows.push({ ...base, key: nextKey(), order: orderRef, diffs: [], status: 'superseded', message: `${compoundNote}Order ${order.ref_number ?? order.qb_sales_order_id} already staged from "${claimed.get(order.qb_sales_order_id)}" — newer sheet wins.` });
              continue;
            }

            const diffs: DiffField[] = [];
            // Cells that had real content but didn't parse for their field's kind
            // (e.g. a PO number typo'd into a currency column, "TBD" in a date
            // column) — flagged rather than silently dropped, since a plain
            // `continue` would hide a spreadsheet data-entry error from review.
            const skipNotes: string[] = [];
            for (const { def, col } of fieldCols) {
              const raw = row[col];
              const currentRaw = (order as any)[def.dbField];

              if (def.kind === 'boolean') {
                const to = raw != null && String(raw).trim() !== '';
                const from = !!currentRaw;
                if (to !== from) diffs.push({ def, from: from ? 'x' : '', to: to ? 'x' : '', value: to });
                continue;
              }

              // Every other kind: a blank cell means "no opinion" — never overwrite with null.
              if (raw == null || String(raw).trim() === '') continue;

              if (def.kind === 'currency') {
                const to = Number(raw);
                if (Number.isNaN(to)) { skipNotes.push(`${def.label} cell isn't a number ("${String(raw).trim()}") — not imported, verify sheet.`); continue; }
                const from = currentRaw == null ? null : Number(currentRaw);
                if (from == null || Math.abs(to - from) > 0.005) {
                  diffs.push({ def, from: from == null ? '' : formatCurrency(from), to: formatCurrency(to), value: Math.round(to * 100) / 100 });
                }
              } else if (def.kind === 'date') {
                if (!(raw instanceof Date)) { skipNotes.push(`${def.label} cell isn't a date ("${String(raw).trim()}") — not imported, verify sheet.`); continue; }
                const to = dateToIso(raw);
                const from = currentRaw || '';
                if (to !== from) diffs.push({ def, from, to, value: to });
              } else {
                const to = String(raw).trim();
                const from = (currentRaw || '').trim();
                if (to !== from) diffs.push({ def, from, to, value: to });
              }
            }

            let message = diffs.length === 0
              ? 'Already matches current order data.'
              : diffs.map((d) => `${d.def.label}: ${d.from || '(blank)'} → ${d.to}`).join('; ');
            if (skipNotes.length) message += `${message ? ' ' : ''}${skipNotes.join(' ')}`;
            if (compoundNote) message = `${compoundNote}${message}`;

            // Sanity check only — sheet's own COMM TOTAL vs its own COMM+OVG, per
            // tbwc-orders-spreadsheet-mapping memory (never written, verify-only).
            if (commTotalCol !== undefined && commCol !== undefined && ovgCol !== undefined) {
              const sheetTotal = row[commTotalCol];
              if (sheetTotal != null && String(sheetTotal).trim() !== '') {
                const comm = Number(row[commCol]) || 0;
                const ovg = Number(row[ovgCol]) || 0;
                const total = Number(sheetTotal);
                if (!Number.isNaN(total) && Math.abs(comm + ovg - total) > 0.01) {
                  message += `${message ? ' ' : ''}Note: sheet's COMM TOTAL (${formatCurrency(total)}) doesn't match COMM+OVG (${formatCurrency(comm + ovg)}) on this row — verify.`;
                }
              }
            }

            claimed.set(order.qb_sales_order_id, name);
            rows.push({ ...base, key: nextKey(), order: orderRef, diffs, status: diffs.length === 0 ? 'no-change' : 'ready', message });
          }
        }
        setEntries([...rows]);
      }
    } catch (e: any) {
      setPlanError(e?.message || 'Failed to read the workbook.');
    } finally {
      setPlanning(false);
    }
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void buildPlan(file);
  };

  const runImport = async () => {
    const ready = entries.filter((e) => e.status === 'ready');
    if (!ready.length) return;
    setRunning(true);
    setProgress({ done: 0, total: ready.length });

    const setEntry = (key: string, patch: Partial<StagedRow>) =>
      setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));

    await runPool(ready, CONCURRENCY, async (entry) => {
      const payload: Record<string, unknown> = {};
      for (const d of entry.diffs) payload[d.def.dbField] = d.value;
      try {
        await ordersService.update(String(entry.order!.qb_sales_order_id), payload as Partial<Order>);
        setEntry(entry.key, { status: 'success', message: `Updated order ${entry.order!.ref_number ?? entry.order!.qb_sales_order_id}.` });
      } catch (err: any) {
        setEntry(entry.key, { status: 'failed', message: err?.message || 'Update failed.' });
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
  const hasRun = successCount + failedCount > 0;

  const statusCounts = useMemo(() => {
    const counts = {} as Record<RowStatus, number>;
    (Object.keys(STATUS_LABELS) as RowStatus[]).forEach((s) => { counts[s] = 0; });
    for (const e of entries) counts[e.status]++;
    return counts;
  }, [entries]);

  const sheetNames = useMemo(() => Array.from(new Set(entries.map((e) => e.sheet))), [entries]);

  const filteredEntries = useMemo(
    () => entries.filter((e) => (statusFilter === 'all' || e.status === statusFilter) && (sheetFilter === 'all' || e.sheet === sheetFilter)),
    [entries, statusFilter, sheetFilter]
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => fileInputRef.current?.click()} disabled={planning || running}>
          Choose workbook…
        </Button>
        {planning && <Typography variant="body2" color="text.secondary">Reading workbook{entries.length ? ` — ${entries.length} row(s) planned so far…` : '…'}</Typography>}
        {!planning && entries.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            {entries.length} row(s) planned — {readyCount} ready, {statusCounts['no-change']} unchanged, {statusCounts['no-match'] + statusCounts.ambiguous} need
            fixing, {statusCounts.superseded} superseded{hasRun ? `, ${successCount} imported, ${failedCount} failed` : ''}.
          </Typography>
        )}
        {!planning && entries.length > 0 && (
          <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadCsv(filteredEntries)}>
            Download {statusFilter === 'all' && sheetFilter === 'all' ? 'log' : 'shown'} (CSV)
          </Button>
        )}
        {!planning && entries.length > 0 && (
          <Button variant="contained" onClick={() => void runImport()} disabled={running || readyCount === 0}>
            {running ? 'Importing…' : `Start Import (${readyCount})`}
          </Button>
        )}
      </Box>
      <input ref={fileInputRef} type="file" hidden accept=".xlsx,.xls" onChange={handleFileChosen} />

      {planError && <Alert severity="error" sx={{ mb: 2 }}>{planError}</Alert>}

      {entries.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">Filter:</Typography>
          <Select size="small" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as RowStatus | 'all')} sx={{ minWidth: 220 }}>
            <MenuItem value="all">All statuses ({entries.length})</MenuItem>
            {(Object.keys(STATUS_LABELS) as RowStatus[]).map((s) => (
              <MenuItem key={s} value={s} disabled={statusCounts[s] === 0}>{STATUS_LABELS[s]} ({statusCounts[s]})</MenuItem>
            ))}
          </Select>
          <Select size="small" value={sheetFilter} onChange={(e) => setSheetFilter(e.target.value)} sx={{ minWidth: 180 }}>
            <MenuItem value="all">All sheets ({entries.length})</MenuItem>
            {sheetNames.map((s) => (
              <MenuItem key={s} value={s}>{s} ({entries.filter((e) => e.sheet === s).length})</MenuItem>
            ))}
          </Select>
          {(statusFilter !== 'all' || sheetFilter !== 'all') && (
            <Button size="small" onClick={() => { setStatusFilter('all'); setSheetFilter('all'); }}>Clear filters</Button>
          )}
          {(statusFilter !== 'all' || sheetFilter !== 'all') && (
            <Typography variant="body2" color="text.secondary">Showing {filteredEntries.length} of {entries.length}.</Typography>
          )}
        </Box>
      )}

      {progress && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>Importing {progress.done} of {progress.total}…</Typography>
          <LinearProgress variant="determinate" value={progress.total ? (progress.done / progress.total) * 100 : 0} />
        </Box>
      )}

      {hasRun && !running && (
        <Alert severity={failedCount ? 'warning' : 'success'} sx={{ mb: 2 }}>
          {successCount} imported, {failedCount} failed.
          {failedCount ? ' Fix the failures, then choose the same workbook again — rows that already match are left alone.' : ''}
        </Alert>
      )}

      {entries.length > 0 && (
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 720, overflowX: 'auto' }}>
          <Table stickyHeader sx={{ minWidth: 1400, tableLayout: 'fixed', '& .MuiTableCell-root': { fontSize: '0.9rem', py: 1.25, whiteSpace: 'normal', wordBreak: 'break-word' } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600, width: 130 }}>Sheet</TableCell>
                <TableCell sx={{ fontWeight: 600, width: 70 }}>Row</TableCell>
                <TableCell sx={{ fontWeight: 600, width: 140 }}>Key</TableCell>
                <TableCell sx={{ fontWeight: 600, width: 160 }}>Order</TableCell>
                <TableCell sx={{ fontWeight: 600, width: 150 }}>Status</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Changes / Message</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredEntries.length === 0 && (
                <TableRow><TableCell colSpan={6} align="center"><Typography variant="body2" color="text.secondary">No rows match the current filter.</Typography></TableCell></TableRow>
              )}
              {filteredEntries.map((entry) => (
                <TableRow key={entry.key} hover>
                  <TableCell>{entry.sheet}</TableCell>
                  <TableCell>{entry.rowNum}</TableCell>
                  <TableCell>
                    <Tooltip title={`${entry.keyType === 'ref' ? 'TBWC#' : 'PO#'} — customer "${entry.customerSheet || '(blank)'}"`}>
                      <span>{entry.keyValue}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{entry.order ? (entry.order.ref_number || entry.order.qb_sales_order_id) : ''}</TableCell>
                  <TableCell><Chip label={STATUS_LABELS[entry.status]} color={STATUS_COLOR[entry.status]} variant="outlined" /></TableCell>
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

export default CommissionImportPanel;
