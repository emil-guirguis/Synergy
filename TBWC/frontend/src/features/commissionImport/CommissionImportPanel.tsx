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
 * field here — it's never written as an overwrite-to-null. Ship date
 * (actual_ship_date) additionally never overwrites an already-set DB value
 * even when the sheet disagrees — the sheet only backfills a blank there.
 *
 * Scope: commission/financial fields (DNC, SOLD FOR, COMM 15%, OVG 75/25,
 * PROJ ADM, Trade Ally) plus ship date. Non-commission columns on the sheet
 * (BUILD NOTES, EXP, JAY, NOTES, JOB NAME, SHIP NLT) are deliberately not
 * imported here.
 */
import React, { useRef, useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import { ImportPanel, StatusChip, downloadCsv as downloadCsvFile, type ImportColumn, type ImportFacet } from '@meterit/framework-frontend/import';
import { ordersService } from '../orders/ordersStore';
import type { Order, OrderImportIndexRow } from '../../types/order';

type FieldKind = 'text' | 'currency' | 'boolean' | 'date';

interface FieldDef {
  dbField: keyof Order & keyof OrderImportIndexRow;
  label: string;
  headers: string[];
  kind: FieldKind;
  /** DB value wins when it's already set — sheet only backfills a blank. */
  fillOnlyIfBlank?: boolean;
}

// Commission-only subset of the TBWC-owned set from the sheet, per
// tbwc-orders-spreadsheet-mapping. Non-commission fields (BUILD NOTES, EXP,
// JAY, NOTES, JOB NAME, SHIP NLT) are deliberately excluded — this panel
// imports commission/financial fields plus actual ship date only.
const FIELD_DEFS: FieldDef[] = [
  { dbField: 'd_net_cost', label: 'D-Net Cost', headers: ['DNC'], kind: 'currency' },
  { dbField: 'sold_for', label: 'Sold For', headers: ['SOLD FOR'], kind: 'currency' },
  { dbField: 'commission', label: 'Commission', headers: ['COMM 15%'], kind: 'currency' },
  { dbField: 'overage', label: 'Overage', headers: ['OVG 75/25'], kind: 'currency' },
  { dbField: 'project_admin_fee', label: 'Proj Admin Fee', headers: ['PROJ ADM'], kind: 'currency' },
  { dbField: 'trade_ally_fee', label: 'Trade Ally Fee', headers: ['Trade Ally'], kind: 'currency' },
  // Column I, "SHIPMENT DATE" — informal free text (e.g. "Shipped 1-7-26"),
  // not a real date cell, hence parseInformalDate below. actual_ship_date is
  // TBWC-owned/manual (migration 035, distinct from QB-synced shipped_date),
  // so an existing DB value is trusted over the sheet — this only backfills.
  { dbField: 'actual_ship_date', label: 'Ship Date', headers: ['SHIPMENT DATE'], kind: 'date', fillOnlyIfBlank: true },
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

/** Column I ("SHIPMENT DATE") is free text like "Shipped 1-7-26", not a real
 *  date cell — pull an embedded M/D/YY(YY) date out of it. 2-digit years are
 *  assumed 2000s (no TBWC order predates that). Null if nothing recognizable. */
function parseInformalDate(text: string): Date | null {
  const m = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  return Number.isNaN(d.getTime()) ? null : d;
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

function downloadCsv(entries: StagedRow[]): void {
  const header = ['Sheet', 'Row', 'Key Type', 'Key', 'Customer (sheet)', 'Order', 'Status', 'Changes', 'Message'];
  const rows = entries.map((e) => [
    e.sheet,
    String(e.rowNum),
    e.keyType,
    e.keyValue,
    e.customerSheet,
    e.order ? (e.order.ref_number || String(e.order.qb_sales_order_id)) : '',
    STATUS_LABELS[e.status],
    e.diffs.map((d) => `${d.def.label}: ${d.from || '(blank)'} -> ${d.to}`).join('; '),
    e.message,
  ]);
  downloadCsvFile('commission-import-log', header, rows);
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
                const parsed = raw instanceof Date ? raw : parseInformalDate(String(raw));
                if (!parsed) { skipNotes.push(`${def.label} cell isn't a date ("${String(raw).trim()}") — not imported, verify sheet.`); continue; }
                if (def.fillOnlyIfBlank && currentRaw) continue; // DB already has a value — sheet never overwrites here
                const to = dateToIso(parsed);
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

  const facets: ImportFacet[] = [
    {
      id: 'status',
      value: statusFilter,
      onChange: (v) => setStatusFilter(v as RowStatus | 'all'),
      allLabel: 'All statuses',
      minWidth: 220,
      options: (Object.keys(STATUS_LABELS) as RowStatus[]).map((s) => ({ value: s, label: STATUS_LABELS[s], count: statusCounts[s] })),
    },
    {
      id: 'sheet',
      value: sheetFilter,
      onChange: (v) => setSheetFilter(v),
      allLabel: 'All sheets',
      minWidth: 180,
      options: sheetNames.map((s) => ({ value: s, label: s, count: entries.filter((e) => e.sheet === s).length })),
    },
  ];

  const columns: ImportColumn<StagedRow>[] = [
    { header: 'Sheet', width: 130, render: (entry) => entry.sheet },
    { header: 'Row', width: 70, render: (entry) => entry.rowNum },
    {
      header: 'Key',
      width: 140,
      render: (entry) => (
        <span title={`${entry.keyType === 'ref' ? 'TBWC#' : 'PO#'} — customer "${entry.customerSheet || '(blank)'}"`}>
          {entry.keyValue}
        </span>
      ),
    },
    { header: 'Order', width: 160, render: (entry) => (entry.order ? (entry.order.ref_number || entry.order.qb_sales_order_id) : '') },
    { header: 'Status', width: 150, render: (entry) => <StatusChip label={STATUS_LABELS[entry.status]} color={STATUS_COLOR[entry.status]} /> },
    { header: 'Changes / Message', render: (entry) => entry.message },
  ];

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

      <ImportPanel<StagedRow>
        rowKey={(entry) => entry.key}
        rows={filteredEntries}
        totalCount={entries.length}
        filtersActive={statusFilter !== 'all' || sheetFilter !== 'all'}
        onClearFilters={() => { setStatusFilter('all'); setSheetFilter('all'); }}
        facets={facets}
        progress={progress ? { done: progress.done, total: progress.total, label: `Importing ${progress.done} of ${progress.total}…` } : null}
        resultAlert={hasRun && !running ? {
          severity: failedCount ? 'warning' : 'success',
          message: (
            <>
              {successCount} imported, {failedCount} failed.
              {failedCount ? ' Fix the failures, then choose the same workbook again — rows that already match are left alone.' : ''}
            </>
          ),
        } : null}
        minTableWidth={1400}
        columns={columns}
      />
    </Box>
  );
};

export default CommissionImportPanel;
