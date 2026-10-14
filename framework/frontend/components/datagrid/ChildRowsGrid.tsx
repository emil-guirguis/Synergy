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
import { useSchema, type ConvertedSchema } from '../form/utils/schemaLoader';
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
  /** Column summed into a footer total (e.g. 'amount'). */
  totalField?: string;
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
  title, totalField, onParentChange, renderCell: renderCustomCell, onAddClick, toolbarActions, busy = false,
  reloadKey, rowFilter, enumOverrides, emptyMessage, deleteConfirmText, containerProps, containerSx,
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

  const columns = useMemo<Column[]>(() => {
    if (!schema) return [];
    return Object.entries(schema.formFields)
      .filter(([, def]) => def.showOn?.includes('list'))
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
  }, [schema, JSON.stringify(enumOverrides ?? null)]);

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

  /** Tab/Shift+Tab across editable cells; Enter = same column next row (adds one past the end); Esc = revert. */
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
      const next = shown[rowIndex + 1];
      if (next) {
        if (isEditable(next, col)) beginEdit(next, col);
        else setActiveCell(null);
      } else if (canCreate && !onAddClick) {
        const key = addRow();
        editStartRef.current = defaults[col.name];
        setActiveCell({ key, col: col.name });
      } else {
        setActiveCell(null);
      }
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

  const total = useMemo(
    () => (totalField ? shown.reduce((sum, r) => sum + (Number(r.values[totalField]) || 0), 0) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, totalField, rowFilter]
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
          className={`editable-data-grid__display${editable ? ' editable-data-grid__display--editable' : ''}${col.type === 'textarea' ? ' editable-data-grid__display--wrap' : ''}`}
          style={col.maxWidth ? { maxWidth: col.maxWidth } : undefined}
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
      const label = col.referenceSearch.displayField ? row.values[col.referenceSearch.displayField] : null;
      return (
        <div onBlur={onBlur} onKeyDown={onKeyDown}>
          <ReferenceSearchField
            config={col.referenceSearch}
            search={search}
            autoFocus
            value={value ?? null}
            valueLabel={label ?? null}
            placeholder={`Search ${col.label.toLowerCase()}…`}
            onChange={(option) => setValue(row.key, {
              [col.name]: option?.value ?? null,
              ...(col.referenceSearch?.displayField ? { [col.referenceSearch.displayField]: option?.label ?? null } : {}),
            })}
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
          <Box className="editable-data-grid__toolbar-title">{title ?? schema?.parent?.label ?? ''}</Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
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
    </Box>
  );
};

export default ChildRowsGrid;
