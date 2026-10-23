import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import MicIcon from '@mui/icons-material/Mic';
import { useSchema, type ConvertedSchema } from '../form/utils/schemaLoader';
import { useFieldVisibility } from '../../auth/fieldVisibility';
import { useReportDirty } from '../form/FormDirtyContext';
import { ReferenceSearchField, type ReferenceSearchConfig, type ReferenceSearchOption } from '../form/ReferenceSearchField';
import { selectOnFocus } from './selectOnFocus';
import { formatCurrency, formatNumber } from '../../utils/numberHelpers';
import './EditableDataGrid.css';

type Id = string | number;

/** App-supplied transport for one child resource (e.g. /quotes/:id/lines) — the grid has no idea
 *  of API base or auth. `parent` is whatever parent-level figures the server recomputed (e.g. total). */
export interface ChildRowsApi {
  list: (parentId: Id) => Promise<Record<string, any>[]>;
  create: (parentId: Id, body: Record<string, any>) => Promise<{ item: Record<string, any>; parent?: Record<string, any> | null }>;
  update: (parentId: Id, id: Id, body: Record<string, any>) => Promise<{ item: Record<string, any>; parent?: Record<string, any> | null }>;
  remove: (parentId: Id, id: Id) => Promise<{ parent?: Record<string, any> | null }>;
}

export interface ChildRowsGridProps {
  /** Child schema key served at /api/schema/:name — declares columns and `parent` (see SchemaDefinition.js). */
  schemaName?: string;
  /** A schema object to use instead of fetching `schemaName` (e.g. a component's built-in default). */
  schema?: ConvertedSchema | null;
  parentId: Id;
  api: ChildRowsApi;
  /** Needed when a column declares `referenceSearch` (same contract as ReferenceSearchField). */
  search?: (config: ReferenceSearchConfig, query: string) => Promise<ReferenceSearchOption[]>;
  /** The caller's `<key>:create/write/delete` grants — the server enforces them too. */
  canCreate?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  /** Title bar text; defaults to the schema's parent.label. */
  title?: string;
  /** Small content right next to the title text itself (e.g. an info icon with a tooltip) —
   *  distinct from toolbarActions, which sits on the opposite side next to Add. */
  titleAdornment?: React.ReactNode;
  /** Column summed into a footer total (e.g. 'amount'). Dropped along with the
   *  column when the caller's role hides it. */
  totalField?: string;
  /** Grant whose per-field visibility decides which columns are shown; defaults
   *  to `<schemaName>:read`. Pass explicitly when the grid is driven by a
   *  `schema` object rather than a `schemaName`. */
  readPermission?: string;
  /** Server-recomputed parent figures after each change (e.g. { total }). */
  onParentChange?: (parent: Record<string, any>) => void;
  /** Custom display content for a column (e.g. a file cell with open/share buttons). Return
   *  undefined to fall back to the default rendering. Custom-rendered columns aren't click-to-edit. */
  renderCell?: (row: Record<string, any>, column: string) => React.ReactNode | undefined;
  /** Replaces Add's default (append a blank row to fill in) — e.g. open a file picker instead.
   *  Also turns off Enter-past-the-last-row adding a row. */
  onAddClick?: () => void;
  /** Extra toolbar buttons, after Add. */
  toolbarActions?: React.ReactNode;
  /** Disables Add / toolbar-driven work (e.g. while a batch upload runs). */
  busy?: boolean;
  /** Change it to re-fetch rows via api.list (e.g. after rows were created outside the grid). */
  reloadKey?: number;
  /** Rows to hide (e.g. document types this viewer may not see). */
  rowFilter?: (row: Record<string, any>) => boolean;
  /** Narrow / relabel a select column's options, per column name. */
  enumOverrides?: Record<string, { values?: string[]; labels?: Record<string, string> }>;
  emptyMessage?: string;
  deleteConfirmText?: (row: Record<string, any>) => string;
  /** Spread on the table container — e.g. drag-and-drop or hover handlers. */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
  containerSx?: SxProps<Theme>;
  /** Adds a mic icon to the toolbar: speak "add 5 <item>" and it searches `column`'s own
   *  referenceSearch config (same endpoint its picker already uses) for the term, lists matches
   *  in a dialog, and inserts a new row with the picked item's fillFields plus the parsed
   *  quantity (into `quantityField`) when clicked. Needs `search` and a SpeechRecognition-capable
   *  browser (Chrome/Edge) — the icon is hidden without `search` and disabled elsewhere.
   *  `aiFallback`, when given, is tried only if the plain `search()` comes back with zero
   *  results for the locally-parsed term. It gets the RAW transcript, not the parsed term —
   *  splitting "<qty> <item>" apart is itself ambiguous whenever the item's own name starts with
   *  a number (e.g. "10 1 amp fuses": qty 10, item "1 amp fuse"), worse when speech-to-text runs
   *  two spoken numbers together ("ten one amp fuses" -> "101 amp fuses") — so the fallback
   *  re-derives both qty and the item from the whole utterance instead of trusting the local
   *  split's guess at either, and its returned qty overrides it. */
  voiceAdd?: {
    column: string;
    quantityField: string;
    aiFallback?: (config: ReferenceSearchConfig, transcript: string) => Promise<{ qty: number; options: ReferenceSearchOption[] }>;
  };
}

interface GridRow {
  key: string;
  id: Id | null;
  values: Record<string, any>;
  /** Last server-confirmed values (or the defaults, for a never-saved row) — dirty = differs from this. */
  saved: Record<string, any>;
  status: 'idle' | 'saving' | 'error';
  error?: string;
}

interface Column {
  name: string;
  label: string;
  type: string;
  readOnly: boolean;
  referenceSearch?: ReferenceSearchConfig;
  min?: number;
  /** Schema `step` — 1 means whole numbers only. */
  step?: number;
  /** Schema `maxWidth` — caps the column; textarea columns wrap inside it. */
  maxWidth?: string;
  /** Schema `maxLength` for text editors. */
  maxLength?: number;
  /** Select (non-referenceSearch) columns. */
  enumValues?: string[];
  enumLabels?: Record<string, string>;
}

let keySeq = 0;
const nextKey = () => `r${++keySeq}`;
const same = (a: any, b: any) => String(a ?? '') === String(b ?? '');

/**
 * Grid for child rows that belong to a parent record (quote lines, ...), driven by the child's own
 * schema file: columns, editability and the row PK all come from GET /api/schema/:schemaName.
 * Unlike PickableLineItemsGrid (whose rows ride along with the parent form's Save), every row here
 * is its own record — it saves itself when focus leaves the row (POST new / PUT changed fields),
 * delete is immediate after a confirm, and the server's recomputed parent figures come back via
 * onParentChange. Only rows that failed to save (or are mid-edit) count as unsaved for the
 * enclosing form's discard-changes guard.
 */
export const ChildRowsGrid: React.FC<ChildRowsGridProps> = ({
  schemaName, schema: schemaProp, parentId, api, search, canCreate = false, canEdit = false, canDelete = false,
  title, titleAdornment, totalField, readPermission, onParentChange, renderCell: renderCustomCell, onAddClick, toolbarActions, busy = false,
  reloadKey, rowFilter, enumOverrides, emptyMessage, deleteConfirmText, containerProps, containerSx, voiceAdd,
}) => {
  const fetched = useSchema(schemaProp ? '' : schemaName ?? '');
  const schema = schemaProp ?? fetched.schema;
  const schemaLoading = schemaProp ? false : fetched.loading;
  const schemaError = schemaProp ? null : fetched.error;
  const [rows, setRows] = useState<GridRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // One cell is editable at a time (spreadsheet-style): every other cell
  // renders as plain text. `activeRef` mirrors it synchronously so blur and
  // mousedown handlers within the same event see the latest value.
  const [activeCell, setActiveCellState] = useState<{ key: string; col: string } | null>(null);
  const activeRef = useRef<{ key: string; col: string } | null>(null);
  // Leaving a row (to another row, or out of the grid) is what saves it.
  const setActiveCell = (cell: { key: string; col: string } | null) => {
    const prev = activeRef.current;
    activeRef.current = cell;
    setActiveCellState(cell);
    if (prev && prev.key !== cell?.key) setTimeout(() => saveRow(prev.key), 0);
  };
  /** The cell's value when editing began, for Esc to revert to. */
  const editStartRef = useRef<any>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<GridRow | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const saveChains = useRef(new Map<string, Promise<void>>());

  const pk = schema?.idFieldName ?? 'id';

  // Columns the caller's role hides are dropped, not just blanked: the API
  // redacts those fields out of every row (see the backend's redactRows), so
  // without this the grid showed a headed, permanently empty column and
  // unticking it in Settings > Roles looked like it did nothing.
  const isFieldVisible = useFieldVisibility();
  const fieldGrant = readPermission ?? (schemaName ? `${schemaName}:read` : null);

  const columns = useMemo<Column[]>(() => {
    if (!schema) return [];
    const listFields = Object.entries(schema.formFields).filter(([, def]) => def.showOn?.includes('list'));
    // An app's isFieldVisible also answers false for a grant the role doesn't
    // hold at all, which would read as "every column hidden". That isn't a
    // column rule, it's a missing grant — and the API already answers 403 for
    // it — so fall back to the schema's own columns rather than render a grid
    // with no columns at all.
    const permitted = fieldGrant ? listFields.filter(([name]) => isFieldVisible(fieldGrant, name)) : listFields;
    return (permitted.length > 0 ? permitted : listFields)
      .map(([name, def]) => {
        const d = def as any;
        return {
          name,
          label: d.label || name,
          type: d.type,
          readOnly: !!d.readOnly,
          referenceSearch: d.referenceSearch,
          min: d.min,
          step: d.step ?? undefined,
          maxWidth: d.maxWidth ?? undefined,
          maxLength: d.maxLength ?? undefined,
          enumValues: enumOverrides?.[name]?.values ?? d.enumValues ?? undefined,
          enumLabels: { ...(d.enumLabels ?? {}), ...(enumOverrides?.[name]?.labels ?? {}) },
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, fieldGrant, isFieldVisible, JSON.stringify(enumOverrides ?? null)]);

  const writable = useMemo(() => columns.filter((c) => !c.readOnly).map((c) => c.name), [columns]);

  const defaults = useMemo(() => {
    const out: Record<string, any> = {};
    if (!schema) return out;
    for (const c of columns) out[c.name] = (schema.formFields[c.name] as any)?.default ?? null;
    return out;
  }, [schema, columns]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api.list(parentId)
      .then((items) => {
        if (cancelled) return;
        setRows(items.map((item) => ({ key: nextKey(), id: item[pk], values: item, saved: item, status: 'idle' })));
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, pk, reloadKey]);

  const changedFields = useCallback(
    (row: GridRow) => writable.filter((c) => !same(row.values[c], row.saved[c])),
    [writable]
  );

  // Unsaved = edited-but-not-yet-sent, or a save that failed. A row mid-save isn't counted, so
  // clicking the modal's Cancel (which blurs the row and kicks off its save first) closes cleanly.
  const hasUnsaved = rows.some((r) => r.status === 'error' || (r.status === 'idle' && changedFields(r).length > 0));
  useReportDirty(`childRows:${schemaName}`, hasUnsaved);

  const patchRow = (key: string, patch: Partial<GridRow> | ((r: GridRow) => Partial<GridRow>)) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r)));

  const setValue = (key: string, changes: Record<string, any>) =>
    patchRow(key, (r) => ({ values: { ...r.values, ...changes } }));

  const doSave = useCallback(async (key: string) => {
    const row = rowsRef.current.find((r) => r.key === key);
    if (!row) return;
    const changed = changedFields(row);
    if (changed.length === 0) return;
    const snapshot = row.values;
    const body: Record<string, any> = {};
    // A new row sends every writable column (defaults included); an existing one only what changed.
    for (const c of row.id == null ? writable : changed) body[c] = snapshot[c];
    patchRow(key, { status: 'saving', error: undefined });
    try {
      const res = row.id == null ? await api.create(parentId, body) : await api.update(parentId, row.id, body);
      const item = res.item;
      patchRow(key, (r) => {
        // Keep anything typed while the request was in flight; take the server's word for the rest.
        const values = { ...item };
        for (const c of writable) if (!same(r.values[c], snapshot[c])) values[c] = r.values[c];
        return { id: item[pk], values, saved: item, status: 'idle' };
      });
      if (res.parent) onParentChange?.(res.parent);
    } catch (e) {
      patchRow(key, { status: 'error', error: e instanceof Error ? e.message : 'Save failed' });
    }
  }, [api, parentId, pk, writable, changedFields, onParentChange]);

  /** Serialised per row, so a second blur while the first save is in flight saves again after it. */
  const saveRow = useCallback((key: string) => {
    const prev = saveChains.current.get(key) ?? Promise.resolve();
    const next = prev.then(() => doSave(key));
    saveChains.current.set(key, next);
  }, [doSave]);

  const addRow = useCallback(() => {
    const key = nextKey();
    setRows((prev) => [...prev, { key, id: null, values: { ...defaults }, saved: { ...defaults }, status: 'idle' }]);
    return key;
  }, [defaults]);

  // Voice Add: mic -> SpeechRecognition transcript -> "add 5 widget" parsed into qty+term ->
  // reuses the column's own referenceSearch endpoint -> dialog of matches -> picking one inserts
  // a row the same way a manual pick would (fillFields + quantityField), then saves it immediately
  // since no cell focus/blur transition happens to trigger the usual autosave.
  const voiceRefConfig = voiceAdd ? columns.find((c) => c.name === voiceAdd.column)?.referenceSearch : undefined;
  const voiceSupported = typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<'listening' | 'searching' | 'ai-searching' | 'results' | 'error'>('listening');
  const [voiceResults, setVoiceResults] = useState<ReferenceSearchOption[]>([]);
  const [voiceMessage, setVoiceMessage] = useState('');
  // What SpeechRecognition actually heard, and what that parsed into — shown in the dialog so a
  // miss is visibly either "misheard" (transcript is wrong) or "misparsed/no catalog match"
  // (transcript is right, term/qty below it is what was actually searched for).
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceParsed, setVoiceParsed] = useState<{ qty: number; term: string } | null>(null);
  const voiceQtyRef = useRef(1);
  const recognitionRef = useRef<any>(null);

  const parseVoiceCommand = (text: string): { qty: number; term: string } => {
    const cleaned = text.trim().replace(/\.$/, '');
    const m = cleaned.match(/^(?:add|insert|get|need)?\s*(\d+(?:\.\d+)?)\s+(?:of\s+)?(.+)$/i);
    return m ? { qty: Number(m[1]), term: m[2].trim() } : { qty: 1, term: cleaned };
  };

  const startVoiceAdd = useCallback(() => {
    if (!search || !voiceRefConfig) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognitionRef.current = recognition;
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    setVoiceResults([]);
    setVoiceMessage('');
    setVoiceTranscript('');
    setVoiceParsed(null);
    setVoiceStatus('listening');
    setVoiceOpen(true);
    recognition.onresult = (e: any) => {
      const transcript = e.results?.[0]?.[0]?.transcript ?? '';
      const { qty, term } = parseVoiceCommand(transcript);
      voiceQtyRef.current = qty;
      setVoiceTranscript(transcript);
      setVoiceParsed({ qty, term });
      setVoiceStatus('searching');
      search(voiceRefConfig, term)
        .then((options) => {
          if (options.length > 0 || !voiceAdd?.aiFallback) {
            setVoiceResults(options);
            setVoiceStatus('results');
            if (options.length === 0) setVoiceMessage(`No matches for "${term}"`);
            return;
          }
          setVoiceStatus('ai-searching');
          return voiceAdd.aiFallback(voiceRefConfig, transcript).then(({ qty: aiQty, options: aiOptions }) => {
            voiceQtyRef.current = aiQty;
            setVoiceParsed({ qty: aiQty, term });
            setVoiceResults(aiOptions);
            setVoiceStatus('results');
            if (aiOptions.length === 0) setVoiceMessage(`No matches for "${transcript}"`);
          });
        })
        .catch((err) => {
          setVoiceStatus('error');
          setVoiceMessage(err instanceof Error ? err.message : 'Search failed');
        });
    };
    recognition.onerror = (e: any) => {
      setVoiceStatus('error');
      setVoiceMessage(e?.error === 'no-speech' ? 'No speech detected' : 'Voice input failed');
    };
    recognition.onend = () => { recognitionRef.current = null; };
    recognition.start();
  }, [search, voiceRefConfig]);

  const closeVoiceDialog = () => {
    recognitionRef.current?.abort();
    setVoiceOpen(false);
  };

  const pickVoiceResult = (option: ReferenceSearchOption) => {
    if (!voiceAdd || !voiceRefConfig) return;
    const valueCol = voiceRefConfig.valueColumn ?? voiceAdd.column;
    const patch: Record<string, any> = {
      [valueCol]: option.value ?? null,
      ...(voiceRefConfig.displayField ? { [voiceRefConfig.displayField]: option.label ?? null } : {}),
      [voiceAdd.quantityField]: voiceQtyRef.current,
    };
    for (const [target, rawField] of Object.entries(voiceRefConfig.fillFields ?? {})) {
      if (option.raw?.[rawField] != null) patch[target] = option.raw[rawField];
    }
    const key = addRow();
    setValue(key, patch);
    setVoiceOpen(false);
    setTimeout(() => saveRow(key), 0);
  };

  const deleteRow = async (row: GridRow) => {
    setConfirmDelete(null);
    if (row.id == null) {
      setRows((prev) => prev.filter((r) => r.key !== row.key));
      return;
    }
    patchRow(row.key, { status: 'saving', error: undefined });
    try {
      const res = await api.remove(parentId, row.id);
      setRows((prev) => prev.filter((r) => r.key !== row.key));
      if (res.parent) onParentChange?.(res.parent);
    } catch (e) {
      patchRow(row.key, { status: 'error', error: e instanceof Error ? e.message : 'Delete failed' });
    }
  };

  const shown = rowFilter ? rows.filter((r) => rowFilter(r.values)) : rows;

  const isEditable = (row: GridRow, col: Column) =>
    !col.readOnly && !renderCustomCell?.(row.values, col.name) && (row.id == null ? canCreate : canEdit);

  const beginEdit = (row: GridRow, col: Column) => {
    if (!isEditable(row, col)) return;
    editStartRef.current = row.values[col.name];
    setActiveCell({ key: row.key, col: col.name });
  };

  /** Focus left the active cell for somewhere outside the grid's cells — leave edit mode (saves the row). */
  const endEdit = (rowKey: string) => {
    if (activeRef.current?.key === rowKey) setActiveCell(null);
  };

  /** Next/previous editable cell, row-major, for Tab / Shift+Tab. */
  const stepCell = (rowIndex: number, colName: string, dir: 1 | -1): { row: GridRow; col: Column } | null => {
    let r = rowIndex;
    let c = columns.findIndex((x) => x.name === colName) + dir;
    while (r >= 0 && r < shown.length) {
      for (; c >= 0 && c < columns.length; c += dir) {
        if (isEditable(shown[r], columns[c])) return { row: shown[r], col: columns[c] };
      }
      r += dir;
      c = dir === 1 ? 0 : columns.length - 1;
    }
    return null;
  };

  /** Advances to the next editable cell to the right (wrapping to the next row); past the last
   *  cell of the last row, adds a row and lands on its first editable column. */
  const advanceFrom = (rowIndex: number, col: Column) => {
    const target = stepCell(rowIndex, col.name, 1);
    if (target) {
      beginEdit(target.row, target.col);
    } else if (canCreate && !onAddClick) {
      const key = addRow();
      const firstEditable = columns.find((c) => !c.readOnly) ?? col;
      editStartRef.current = defaults[firstEditable.name];
      setActiveCell({ key, col: firstEditable.name });
    } else {
      setActiveCell(null);
    }
  };

  // Set right before advanceFrom() runs from a referenceSearch cell's onChange (a mouse click
  // on a dropdown option never fires a keydown at all, so that's the only reliable place to
  // advance from); cleared on the next tick. Lets handleKeyDown's own Enter handling — which
  // still runs, bubbling up from MUI's own Enter-selects-the-highlighted-option handling on the
  // same keystroke — recognize "already advanced for this pick" and skip a second, double step.
  const justPickedRef = useRef(false);

  /** Tab/Shift+Tab and Enter both step to the next editable cell to the right; Esc = revert. */
  const handleKeyDown = (rowIndex: number, col: Column) => (e: React.KeyboardEvent) => {
    const row = shown[rowIndex];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't let the enclosing modal treat it as "close"
      setValue(row.key, { [col.name]: editStartRef.current });
      setActiveCell(null);
      return;
    }
    if (e.key === 'Tab') {
      const target = stepCell(rowIndex, col.name, e.shiftKey ? -1 : 1);
      if (!target) return; // let focus leave the grid; blur saves the row
      e.preventDefault();
      beginEdit(target.row, target.col);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); // also stops the implicit <form> submit
      if (justPickedRef.current) { justPickedRef.current = false; return; }
      advanceFrom(rowIndex, col);
    }
  };

  const handleAddClick = () => {
    if (onAddClick) { onAddClick(); return; }
    const firstEditable = columns.find((c) => !c.readOnly);
    const key = addRow();
    if (firstEditable) {
      editStartRef.current = defaults[firstEditable.name];
      setActiveCell({ key, col: firstEditable.name });
    }
  };

  // No footer total for a column the role can't see — the rows don't carry it.
  const totalShown = !!totalField && columns.some((c) => c.name === totalField);
  const total = useMemo(
    () => (totalShown ? shown.reduce((sum, r) => sum + (Number(r.values[totalField!]) || 0), 0) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, totalField, totalShown, rowFilter]
  );

  const widthOf = (col: Column) =>
    col.type === 'textarea' ? '40%' : col.referenceSearch ? '22%' : col.type === 'currency' ? '13%' : '10%';
  const isNumeric = (col: Column) => col.type === 'number' || col.type === 'currency';
  const alignOf = (col: Column) => (isNumeric(col) ? 'right' : 'left');

  /** Read-only rendering of a value — also what every non-active editable cell shows. */
  const displayText = (row: GridRow, col: Column): string => {
    const value = row.values[col.name];
    if (col.referenceSearch) {
      return (col.referenceSearch.displayField ? row.values[col.referenceSearch.displayField] : null) ?? '';
    }
    if (col.enumValues && !col.referenceSearch) return value == null ? '' : col.enumLabels?.[value] ?? String(value);
    if (col.type === 'date' || col.type === 'datetime') {
      if (!value) return '';
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '' : col.type === 'date' ? d.toLocaleDateString() : d.toLocaleString();
    }
    if (col.type === 'currency') return formatCurrency(value);
    if (col.type === 'number') {
      return formatNumber(value, { maximumFractionDigits: col.step === 1 ? 0 : 2 });
    }
    return value ?? '';
  };

  const renderCell = (row: GridRow, rowIndex: number, col: Column) => {
    const custom = renderCustomCell?.(row.values, col.name);
    if (custom !== undefined) return custom;
    const editable = isEditable(row, col);
    const active = activeCell?.key === row.key && activeCell?.col === col.name;

    if (!active) {
      const text = displayText(row, col);
      return (
        <div
          className={`editable-data-grid__display${editable ? ' editable-data-grid__display--editable' : ''}`}
          style={col.maxWidth ? { maxWidth: col.maxWidth } : undefined}
          title={text || undefined}
          // mousedown, not click: claims the active cell before the current
          // input's blur fires, so moving within the row doesn't save it early.
          onMouseDown={editable ? (e) => { e.preventDefault(); beginEdit(row, col); } : undefined}
        >
          {text || (editable && col.referenceSearch ? (
            <span className="editable-data-grid__placeholder">{`Search ${col.label.toLowerCase()}…`}</span>
          ) : '\u00a0')}
        </div>
      );
    }

    const value = row.values[col.name];
    const onKeyDown = handleKeyDown(rowIndex, col);
    const onBlur = (e: React.FocusEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) endEdit(row.key);
    };

    if (col.referenceSearch && search) {
      const refConfig = col.referenceSearch;
      const valueCol = refConfig.valueColumn ?? col.name;
      const label = refConfig.displayField ? row.values[refConfig.displayField] : null;
      return (
        <div onBlur={onBlur} onKeyDown={onKeyDown}>
          <ReferenceSearchField
            config={refConfig}
            search={search}
            autoFocus
            value={row.values[valueCol] ?? null}
            valueLabel={label ?? null}
            placeholder={`Search ${col.label.toLowerCase()}…`}
            onChange={(option) => {
              const patch: Record<string, any> = {
                [valueCol]: option?.value ?? null,
                ...(refConfig.displayField ? { [refConfig.displayField]: option?.label ?? null } : {}),
              };
              for (const [target, rawField] of Object.entries(refConfig.fillFields ?? {})) {
                if (option?.raw?.[rawField] != null) patch[target] = option.raw[rawField];
              }
              setValue(row.key, patch);
              if (option) {
                justPickedRef.current = true;
                setTimeout(() => { justPickedRef.current = false; }, 0);
                advanceFrom(rowIndex, col);
              }
            }}
          />
        </div>
      );
    }

    if (col.enumValues) {
      // Opens straight away; picking (or closing the menu) ends the edit. Not
      // ended on blur — the menu is a portal, so focus leaves the cell while
      // it's open.
      return (
        <TextField
          select size="small" fullWidth variant="outlined" autoFocus
          value={value ?? ''}
          onKeyDown={onKeyDown}
          SelectProps={{
            defaultOpen: true,
            onClose: () => setTimeout(() => endEdit(row.key), 0),
          }}
          onChange={(e) => setValue(row.key, { [col.name]: e.target.value })}
        >
          {col.enumValues.map((v) => (
            <MenuItem key={v} value={v}>{col.enumLabels?.[v] ?? v}</MenuItem>
          ))}
        </TextField>
      );
    }

    const numeric = isNumeric(col);
    const wholeOnly = col.step === 1;
    const wrap = col.type === 'textarea';
    return (
      <TextField
        size="small" fullWidth variant="outlined" autoFocus
        // Wrapped columns edit as an auto-growing textarea, so the editor is
        // exactly as tall as the wrapped text it replaces.
        multiline={wrap}
        minRows={wrap ? 1 : undefined}
        sx={col.maxWidth ? { maxWidth: col.maxWidth } : undefined}
        type={numeric ? 'number' : 'text'}
        onFocus={numeric ? selectOnFocus : undefined}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        value={value ?? ''}
        inputProps={{ min: col.min, step: col.step, maxLength: col.maxLength, style: numeric ? { textAlign: 'right' } : undefined }}
        onChange={(e) => {
          let v: string | null = e.target.value;
          if (numeric) {
            if (wholeOnly) v = v.replace(/[.,].*$/, '');
            if (v === '') v = null;
          }
          setValue(row.key, { [col.name]: v });
        }}
      />
    );
  };

  const showActions = canDelete || canCreate;
  const colSpan = columns.length + (showActions ? 1 : 0);

  if (schemaError) return <Alert severity="error">{String(schemaError)}</Alert>;

  return (
    <Box>
      <Box className="editable-data-grid__wrapper editable-data-grid__wrapper--inline-inputs">
        <Box className="editable-data-grid__toolbar">
          <Box className="editable-data-grid__toolbar-title" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {title ?? schema?.parent?.label ?? ''}
            {titleAdornment}
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            {voiceAdd && canCreate && search && (
              <Tooltip title={voiceSupported ? 'Voice add (e.g. "add 5 widget")' : 'Voice add needs Chrome or Edge'}>
                <span>
                  <IconButton
                    size="small" color="primary"
                    onClick={startVoiceAdd}
                    disabled={!voiceSupported || loading || schemaLoading || busy}
                    aria-label="Voice add"
                  >
                    <MicIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {canCreate && (
              <Button
                variant="contained" color="primary" size="small"
                startIcon={<AddIcon fontSize="small" />}
                onClick={handleAddClick}
                disabled={loading || schemaLoading || busy}
                className="editable-data-grid__add-button"
              >
                Add
              </Button>
            )}
            {toolbarActions}
          </Box>
        </Box>
        <TableContainer
          {...containerProps}
          sx={containerSx}
          className="editable-data-grid__table editable-data-grid__table--inset"
        >
          <Table>
            <TableHead>
              <TableRow>
                {columns.map((col) => (
                  <TableCell
                    key={col.name}
                    className="editable-data-grid__header-cell"
                    style={{ width: widthOf(col), maxWidth: col.maxWidth }}
                    align={alignOf(col)}
                  >
                    {col.label}
                  </TableCell>
                ))}
                {showActions && (
                  <TableCell className="editable-data-grid__header-cell editable-data-grid__actions-header-cell" style={{ width: 44 }} />
                )}
              </TableRow>
            </TableHead>
            <TableBody>
              {loading || schemaLoading ? (
                <TableRow>
                  <TableCell colSpan={colSpan} align="center" className="editable-data-grid__empty">
                    <CircularProgress size={20} />
                  </TableCell>
                </TableRow>
              ) : loadError ? (
                <TableRow>
                  <TableCell colSpan={colSpan}><Alert severity="error">{loadError}</Alert></TableCell>
                </TableRow>
              ) : shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={colSpan} align="center" className="editable-data-grid__empty">
                    {emptyMessage ?? `No ${(title ?? schema?.parent?.label ?? 'rows').toLowerCase()}`}
                  </TableCell>
                </TableRow>
              ) : (
                shown.map((row, i) => {
                  const unsaved = row.status === 'error' || changedFields(row).length > 0;
                  return (
                    <TableRow
                      key={row.key}
                      className={`editable-data-grid__row${unsaved ? ' editable-data-grid__row--changed' : ''}`}
                    >
                      {columns.map((col) => (
                        <TableCell
                          key={col.name}
                          className="editable-data-grid__cell"
                          align={alignOf(col)}
                          data-row-key={row.key}
                          data-col={col.name}
                        >
                          {renderCell(row, i, col)}
                        </TableCell>
                      ))}
                      {showActions && (
                        <TableCell className="editable-data-grid__actions-cell" align="right">
                          {row.status === 'saving' ? (
                            <CircularProgress size={14} />
                          ) : row.status === 'error' ? (
                            <Tooltip title={`${row.error ?? 'Save failed'} — click to retry`}>
                              <IconButton size="small" color="error" tabIndex={-1} onClick={() => saveRow(row.key)}>
                                <ErrorOutlineIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          ) : (row.id == null || canDelete) ? (
                            <IconButton
                              size="small" tabIndex={-1} aria-label="Delete row"
                              className="editable-data-grid__delete-button"
                              onClick={() => (row.id == null ? deleteRow(row) : setConfirmDelete(row))}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          ) : null}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
      {total !== null && shown.length > 0 && (
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
          <Typography variant="subtitle2">Total: {formatCurrency(total)}</Typography>
        </Stack>
      )}

      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} maxWidth="xs">
        <DialogTitle>Delete this row?</DialogTitle>
        <DialogContent>
          {confirmDelete && deleteConfirmText
            ? deleteConfirmText(confirmDelete.values)
            : "It is removed immediately — this can't be undone."}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)} autoFocus>Cancel</Button>
          <Button color="error" onClick={() => confirmDelete && deleteRow(confirmDelete)}>Delete</Button>
        </DialogActions>
      </Dialog>

      {voiceAdd && (
        <Dialog open={voiceOpen} onClose={closeVoiceDialog} maxWidth="xs" fullWidth>
          <DialogTitle>Voice Add</DialogTitle>
          <DialogContent>
            {voiceTranscript && (
              <Stack spacing={0.25} sx={{ mb: 1.5 }}>
                <Typography variant="body2">Heard: "{voiceTranscript}"</Typography>
                {voiceParsed && (
                  <Typography variant="caption" color="text.secondary">
                    Searching: {voiceParsed.qty} × "{voiceParsed.term}"
                  </Typography>
                )}
              </Stack>
            )}
            {voiceStatus === 'listening' && (
              <Stack alignItems="center" spacing={1} sx={{ py: 2 }}>
                <MicIcon color="primary" fontSize="large" />
                <Typography variant="body2" color="text.secondary">Listening… try "add 5 widget"</Typography>
              </Stack>
            )}
            {voiceStatus === 'searching' && (
              <Stack alignItems="center" sx={{ py: 2 }}><CircularProgress size={24} /></Stack>
            )}
            {voiceStatus === 'ai-searching' && (
              <Stack alignItems="center" spacing={1} sx={{ py: 2 }}>
                <CircularProgress size={24} />
                <Typography variant="body2" color="text.secondary">No exact match — asking AI…</Typography>
              </Stack>
            )}
            {voiceStatus === 'error' && <Alert severity="error">{voiceMessage}</Alert>}
            {voiceStatus === 'results' && voiceResults.length === 0 && <Alert severity="info">{voiceMessage}</Alert>}
            {voiceStatus === 'results' && voiceResults.length > 0 && (
              <List dense>
                {voiceResults.map((opt) => (
                  <ListItemButton key={String(opt.value)} onClick={() => pickVoiceResult(opt)}>
                    <ListItemText
                      primary={opt.label}
                      secondary={voiceRefConfig?.descriptionField ? opt.raw?.[voiceRefConfig.descriptionField] : undefined}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={closeVoiceDialog}>Cancel</Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
};

export default ChildRowsGrid;
