import React, { useCallback, useMemo } from 'react';
import { Box, Button, IconButton, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { ReferenceSearchField, type ReferenceSearchConfig, type ReferenceSearchOption } from '../form/ReferenceSearchField';

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
}

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function computeAmount(line: Record<string, any>, config: LineItemPickerConfig): number | null {
  const qty = line[config.quantityField];
  const rate = line[config.rateField];
  return qty != null && rate != null ? Math.round(qty * rate * 100) / 100 : null;
}

/**
 * Add/remove line-item grid with an async item picker per row — declared on a schema field via
 * `lineItemPicker` (see SchemaDefinition.js) and only meaningful while creating a new record
 * (an already-synced record's lines come from the external system, not this grid). Distinct from
 * EditableDataGrid: that one edits fixed, already-existing rows; this one builds the row set
 * itself (add, pick an item into it, remove it).
 */
export const PickableLineItemsGrid: React.FC<PickableLineItemsGridProps> = ({
  lines, config, disabled = false, search, onChange,
}) => {
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
    onChange(next);
  }, [lines, config, onChange]);

  const addLine = useCallback(() => {
    onChange([...lines, { item: null, itemValue: null, [config.descField]: '', [config.quantityField]: null, [config.rateField]: null, amount: null }]);
  }, [lines, config, onChange]);

  const removeLine = useCallback((index: number) => {
    onChange(lines.filter((_, i) => i !== index));
  }, [lines, onChange]);

  return (
    <Box>
      <Stack spacing={1}>
        {lines.map((line, i) => (
          <Stack key={i} direction="row" spacing={1} alignItems="flex-start">
            <Box sx={{ flex: '1 1 28%' }}>
              <ReferenceSearchField
                config={config.itemSearch}
                search={search}
                disabled={disabled}
                value={line.itemValue ?? null}
                valueLabel={line.item ?? null}
                placeholder="Search item…"
                onChange={(option) => updateLine(i, { itemValue: option?.value ?? null, item: option?.label ?? null })}
              />
            </Box>
            <TextField
              size="small"
              sx={{ flex: '1 1 32%' }}
              placeholder="Description"
              disabled={disabled}
              value={line[config.descField] ?? ''}
              onChange={(e) => updateLine(i, { [config.descField]: e.target.value })}
            />
            <TextField
              size="small"
              sx={{ flex: '0 1 12%' }}
              placeholder="Qty"
              type="number"
              disabled={disabled}
              value={line[config.quantityField] ?? ''}
              onChange={(e) => updateLine(i, { [config.quantityField]: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <TextField
              size="small"
              sx={{ flex: '0 1 14%' }}
              placeholder="Rate"
              type="number"
              disabled={disabled}
              value={line[config.rateField] ?? ''}
              onChange={(e) => updateLine(i, { [config.rateField]: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <Box sx={{ flex: '0 1 12%', pt: 1 }}>
              <Typography variant="body2" align="right">{line.amount != null ? money(line.amount) : '—'}</Typography>
            </Box>
            <IconButton size="small" onClick={() => removeLine(i)} disabled={disabled} aria-label="Remove line">
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Stack>
        ))}
      </Stack>
      {!disabled && (
        <Button startIcon={<AddIcon />} onClick={addLine} size="small" sx={{ mt: 1 }}>
          Add line
        </Button>
      )}
      {lines.length > 0 && (
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
          <Typography variant="subtitle2">Subtotal: {money(subtotal)}</Typography>
        </Stack>
      )}
    </Box>
  );
};

export default PickableLineItemsGrid;
