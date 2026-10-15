import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useReportDirty } from '../form/FormDirtyContext';
import { ReferenceSearchField, type ReferenceSearchConfig, type ReferenceSearchOption } from '../form/ReferenceSearchField';
import { selectOnFocus } from './selectOnFocus';
import './EditableDataGrid.css';

export interface LineItemPickerConfig {
  itemSearch: ReferenceSearchConfig;
  /** Same shape as itemSearch, for picking the same underlying item by searching its description
   *  instead of its code (e.g. { ...itemSearch, searchFields: ['sales_desc'] }). When set, the
   *  Description cell becomes a second picker into the same line rather than free text. */
  descSearch?: ReferenceSearchConfig;
  descField: string;
  quantityField: string;
  rateField: string;
  /** Raw fields to copy onto the line from whichever picker's result (itemSearch or descSearch),
   *  as { lineKey: rawField } — e.g. { item: 'full_name', desc: 'sales_desc', rate: 'sales_price' },
   *  so Item/Description/Rate stay in sync no matter which cell's search found the match. */
  fillFields?: Record<string, string>;
}

export interface PickableLineItemsGridProps {
  /** Line rows, shaped generically — `item`/`itemValue` hold the picked reference (label/value),
   *  config.descField/quantityField/rateField name the rest. `amount` is always quantity * rate. */
  lines: Record<string, any>[];
  config: LineItemPickerConfig;
  disabled?: boolean;
  search: (config: ReferenceSearchConfig, query: string) => Promise<ReferenceSearchOption[]>;
  onChange: (lines: Record<string, any>[]) => void;
  /** Title bar above the grid (same chrome as EditableDataGrid's own `title`) — the schema
   *  section wrapping this field should be `bare: true` so BaseForm doesn't draw a second one. */
  title?: string;
}

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function computeAmount(line: Record<string, any>, config: LineItemPickerConfig): number | null {
  const qty = line[config.quantityField];
  const rate = line[config.rateField];
  return qty != null && rate != null ? Math.round(qty * rate * 100) / 100 : null;
}

// Explicit widths so header and body cells line up (same approach as OrderLinesGrid).
const WIDTHS = { item: '22%', desc: '40%', quantity: '10%', rate: '12%', amount: '12%', actions: '44px' };

/**
 * Add/remove line-item grid with an async item picker per row — declared on a schema field via
 * `lineItemPicker` (see SchemaDefinition.js) and only meaningful while creating a new record
 * (an already-synced record's lines come from the external system, not this grid). Distinct from
 * EditableDataGrid: that one edits fixed, already-existing rows; this one builds the row set
 * itself (add, pick an item into it, remove it). Shares EditableDataGrid's CSS classes so the two
 * line-item grids in the app read as the same component, not two different tables.
 */
export const PickableLineItemsGrid: React.FC<PickableLineItemsGridProps> = ({
  lines, config, disabled = false, search, onChange, title = 'Line Items',
}) => {
  // Description collapses to one ellipsised line so rows stay grid-height; the focused one expands.
  const [editingDescIndex, setEditingDescIndex] = useState<number | null>(null);

  // Changed-row tracking by object identity: updateLine/addLine always produce new
  // row objects, so any row not in the baseline set was added or edited — no marker
  // fields leak into the lines the parent saves. Until the user edits, the baseline
  // follows `lines` (the parent may swap in a freshly-fetched copy after mount).
  const [userEdited, setUserEdited] = useState(false);
  const baselineRef = useRef<Set<Record<string, any>>>(new Set(lines));
  if (!userEdited) baselineRef.current = new Set(lines);
  useReportDirty('lineItems', userEdited);

  // Cell to focus once the next render lands (Enter past the last row adds one).
  const pendingFocusRef = useRef<{ row: number; col: string } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const focusCell = useCallback((row: number, col: string) => {
    const el = tableRef.current?.querySelector<HTMLElement>(
      `[data-line-row="${row}"][data-line-col="${col}"] input, [data-line-row="${row}"][data-line-col="${col}"] textarea`
    );
    if (!el) return false;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
    return true;
  }, []);

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (target && focusCell(target.row, target.col)) pendingFocusRef.current = null;
  });

  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + (computeAmount(l, config) ?? 0), 0),
    [lines, config]
  );

  const updateLine = useCallback((index: number, patch: Record<string, any>) => {
    const next = lines.map((l, i) => {
      if (i !== index) return l;
      const updated = { ...l, ...patch };
      updated.amount = computeAmount(updated, config);
      return updated;
    });
    setUserEdited(true);
    onChange(next);
  }, [lines, config, onChange]);

  const addLine = useCallback(() => {
    setUserEdited(true);
    onChange([...lines, { item: null, itemValue: null, [config.descField]: '', [config.quantityField]: null, [config.rateField]: null, amount: null }]);
  }, [lines, config, onChange]);

  const removeLine = useCallback((index: number) => {
    setUserEdited(true);
    onChange(lines.filter((_, i) => i !== index));
  }, [lines, onChange]);

  /** Applies a picked option from either the Item or Description cell — both pick the same
   *  underlying item, so either one sets itemValue/item and whatever fillFields declares
   *  (typically desc + rate), always off the option's raw row rather than its own label/value
   *  (which differ: Description's own pick labels/searches by sales_desc, not full_name). */
  const applyPick = useCallback((index: number, option: ReferenceSearchOption | null) => {
    const patch: Record<string, any> = { itemValue: option?.value ?? null, item: option?.label ?? null };
    for (const [target, rawField] of Object.entries(config.fillFields ?? {})) {
      if (option?.raw?.[rawField] != null) patch[target] = option.raw[rawField];
    }
    updateLine(index, patch);
  }, [config, updateLine]);

  const COLS = ['item', 'desc', 'qty', 'rate'] as const;

  // Set right before stepTo() runs from a picker's onChange (a mouse click on a dropdown
  // option never fires a keydown at all, so that's the only reliable place to advance from);
  // cleared on the next tick. Lets handleStepKeyDown's own Enter handling — which still runs,
  // bubbling up from MUI's own Enter-selects-the-highlighted-option handling on the same
  // keystroke — recognize "already advanced for this pick" and skip a second, double step.
  const justPickedRef = useRef(false);

  /** Steps to the next cell to the right; past the last column of the last row, adds a new line. */
  const stepTo = useCallback((row: number, col: typeof COLS[number]) => {
    const colIdx = COLS.indexOf(col);
    if (colIdx < COLS.length - 1) {
      focusCell(row, COLS[colIdx + 1]);
      return;
    }
    if (row + 1 < lines.length) {
      focusCell(row + 1, COLS[0]);
    } else {
      pendingFocusRef.current = { row: row + 1, col: COLS[0] };
      addLine();
    }
  }, [focusCell, lines.length, addLine]);

  /** Enter and Tab both step to the next cell to the right (see stepTo). Shift+Enter is left
   *  alone (newline in the description); Shift+Tab is left alone (native backward tab). */
  const handleStepKeyDown = (row: number, col: typeof COLS[number]) => (e: React.KeyboardEvent) => {
    if (disabled || e.shiftKey) return;
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    e.preventDefault(); // also stops the implicit <form> submit on Enter
    if (justPickedRef.current) { justPickedRef.current = false; return; }
    stepTo(row, col);
  };

  /** A picker's onChange: applies the pick, then advances the same way Tab/Enter would —
   *  covers a mouse click on a dropdown option, which never fires a keydown to hang that off. */
  const applyPickAndStep = useCallback((row: number, col: typeof COLS[number], option: ReferenceSearchOption | null) => {
    applyPick(row, option);
    if (!option) return;
    justPickedRef.current = true;
    setTimeout(() => { justPickedRef.current = false; }, 0);
    stepTo(row, col);
  }, [applyPick, stepTo]);

  const handleAddClick = () => {
    pendingFocusRef.current = { row: lines.length, col: 'item' };
    addLine();
  };

  return (
    <Box>
      <Box className="editable-data-grid__wrapper editable-data-grid__wrapper--inline-inputs">
        <Box className="editable-data-grid__toolbar">
          <Box className="editable-data-grid__toolbar-title">{title}</Box>
          {!disabled && (
            <Button
              variant="contained"
              color="primary"
              size="small"
              startIcon={<AddIcon fontSize="small" />}
              onClick={handleAddClick}
              className="editable-data-grid__add-button"
            >
              Add
            </Button>
          )}
        </Box>
      <TableContainer ref={tableRef} className="editable-data-grid__table editable-data-grid__table--inset">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell className="editable-data-grid__header-cell" style={{ width: WIDTHS.item }}>Item</TableCell>
              <TableCell className="editable-data-grid__header-cell" style={{ width: WIDTHS.desc }}>Description</TableCell>
              <TableCell className="editable-data-grid__header-cell" style={{ width: WIDTHS.quantity }}>Qty</TableCell>
              <TableCell className="editable-data-grid__header-cell" style={{ width: WIDTHS.rate }}>Rate</TableCell>
              <TableCell className="editable-data-grid__header-cell" style={{ width: WIDTHS.amount }} align="right">Amount</TableCell>
              <TableCell
                className="editable-data-grid__header-cell editable-data-grid__actions-header-cell"
                style={{ width: WIDTHS.actions }}
              />
            </TableRow>
          </TableHead>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} align="center" className="editable-data-grid__empty">
                  No line items
                </TableCell>
              </TableRow>
            ) : (
              lines.map((line, i) => (
                <TableRow
                  key={i}
                  className={`editable-data-grid__row${baselineRef.current.has(line) ? '' : ' editable-data-grid__row--changed'}`}
                >
                  <TableCell className="editable-data-grid__cell" data-line-row={i} data-line-col="item">
                    <div onKeyDown={handleStepKeyDown(i, 'item')}>
                      <ReferenceSearchField
                        config={config.itemSearch}
                        search={search}
                        disabled={disabled}
                        value={line.itemValue ?? null}
                        valueLabel={line.item ?? null}
                        placeholder="Search item…"
                        onChange={(option) => applyPickAndStep(i, 'item', option)}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="editable-data-grid__cell" data-line-row={i} data-line-col="desc">
                    {config.descSearch ? (
                      <div onKeyDown={handleStepKeyDown(i, 'desc')}>
                        <ReferenceSearchField
                          config={config.descSearch}
                          search={search}
                          disabled={disabled}
                          value={line.itemValue ?? null}
                          valueLabel={line[config.descField] ?? null}
                          placeholder="Search description…"
                          onChange={(option) => applyPickAndStep(i, 'desc', option)}
                        />
                      </div>
                    ) : (
                      <TextField
                        size="small"
                        fullWidth
                        onKeyDown={handleStepKeyDown(i, 'desc')}
                        multiline={editingDescIndex === i}
                        maxRows={4}
                        variant="outlined"
                        onFocus={() => setEditingDescIndex(i)}
                        onBlur={() => setEditingDescIndex(null)}
                        placeholder="Description"
                        disabled={disabled}
                        value={line[config.descField] ?? ''}
                        onChange={(e) => updateLine(i, { [config.descField]: e.target.value })}
                      />
                    )}
                  </TableCell>
                  <TableCell className="editable-data-grid__cell" data-line-row={i} data-line-col="qty">
                    <TextField
                      size="small"
                      fullWidth
                      onKeyDown={handleStepKeyDown(i, 'qty')}
                      variant="outlined"
                      placeholder="Qty"
                      type="number"
                      onFocus={selectOnFocus}
                      disabled={disabled}
                      value={line[config.quantityField] ?? ''}
                      onChange={(e) => updateLine(i, { [config.quantityField]: e.target.value === '' ? null : Number(e.target.value) })}
                    />
                  </TableCell>
                  <TableCell className="editable-data-grid__cell" data-line-row={i} data-line-col="rate">
                    <TextField
                      size="small"
                      fullWidth
                      onKeyDown={handleStepKeyDown(i, 'rate')}
                      variant="outlined"
                      placeholder="Rate"
                      type="number"
                      onFocus={selectOnFocus}
                      disabled={disabled}
                      value={line[config.rateField] ?? ''}
                      onChange={(e) => updateLine(i, { [config.rateField]: e.target.value === '' ? null : Number(e.target.value) })}
                    />
                  </TableCell>
                  <TableCell className="editable-data-grid__cell" align="right">
                    <Typography variant="body2">{line.amount != null ? money(line.amount) : '—'}</Typography>
                  </TableCell>
                  <TableCell className="editable-data-grid__actions-cell" align="right">
                    <IconButton
                      size="small"
                      onClick={() => removeLine(i)}
                      disabled={disabled}
                      aria-label="Remove line"
                      tabIndex={-1}
                      className="editable-data-grid__delete-button"
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      </Box>
      {lines.length > 0 && (
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
          <Typography variant="subtitle2">Subtotal: {money(subtotal)}</Typography>
        </Stack>
      )}
    </Box>
  );
};

export default PickableLineItemsGrid;
