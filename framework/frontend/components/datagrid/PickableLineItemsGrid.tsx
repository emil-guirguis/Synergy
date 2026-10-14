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
  descField: string;
  quantityField: string;
  rateField: string;
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

  /** Spreadsheet-style Enter: same column, next row; past the last row adds a new line.
   *  Shift+Enter is left alone (newline in the description). */
  const handleEnter = (row: number, col: string) => (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || disabled) return;
    e.preventDefault(); // also stops the implicit <form> submit
    if (row + 1 < lines.length) {
      focusCell(row + 1, col);
    } else {
      pendingFocusRef.current = { row: row + 1, col };
      addLine();
    }
  };

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
                    <ReferenceSearchField
                      config={config.itemSearch}
                      search={search}
                      disabled={disabled}
                      value={line.itemValue ?? null}
                      valueLabel={line.item ?? null}
                      placeholder="Search item…"
                      onChange={(option) => updateLine(i, { itemValue: option?.value ?? null, item: option?.label ?? null })}
                    />
                  </TableCell>
                  <TableCell className="editable-data-grid__cell" data-line-row={i} data-line-col="desc">
                    <TextField
                      size="small"
                      fullWidth
                      onKeyDown={handleEnter(i, 'desc')}
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
                  </TableCell>
                  <TableCell className="editable-data-grid__cell" data-line-row={i} data-line-col="qty">
                    <TextField
                      size="small"
                      fullWidth
                      onKeyDown={handleEnter(i, 'qty')}
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
                      onKeyDown={handleEnter(i, 'rate')}
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
