import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import { EditableDataGrid, type GridColumn } from '@meterit/framework-frontend/components/datagrid/';
import type { EstimateLine } from '../../types/estimate';

interface EstimateLinesGridProps {
  lines: EstimateLine[] | null;
  total?: number | string | null;
  /** Reps (and anyone without estimate:write) see line items read-only. */
  readOnly?: boolean;
  /** Fires with the full updated line array on every committed cell edit —
   *  EstimateForm holds this as the form's pending `lines` value. Only
   *  quantity/rate/desc are ever editable; item and a line's txnLineId are
   *  never touched (txnLineId is what a push later targets the line by). */
  onChange?: (lines: EstimateLine[]) => void;
}

const money = (n: number | string) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const WIDTHS = { item: '16%', desc: '38%', quantity: '12%', rate: '14%', amount: '20%' };

const COLUMNS: GridColumn[] = [
  { key: 'item', label: 'Item', editable: false, width: WIDTHS.item },
  { key: 'desc', label: 'Description', editable: true, type: 'text', width: WIDTHS.desc },
  { key: 'quantity', label: 'Qty', editable: true, type: 'number', width: WIDTHS.quantity },
  { key: 'rate', label: 'Rate', editable: true, type: 'number', width: WIDTHS.rate },
  { key: 'amount', label: 'Amount', editable: false, width: WIDTHS.amount },
];

const COLUMNS_READONLY: GridColumn[] = COLUMNS.map((c) => ({ ...c, editable: false }));

/** Editable EstimateLineRet line items — quantity/rate/desc only, staged into
 *  the estimate's 'lines' draft push on save (see EstimateForm/estimates.ts).
 *  Read-only line items (no push target) are simply skipped when building the
 *  push — see estimate.ts's pendingModRqs. */
export const EstimateLinesGrid: React.FC<EstimateLinesGridProps> = ({ lines, total, readOnly = false, onChange }) => {
  const [rows, setRows] = useState<EstimateLine[]>(lines ?? []);

  // Re-seed local state when a fresh record loads (not on every parent
  // render — EstimateForm always passes a new array reference otherwise).
  useEffect(() => { setRows(lines ?? []); }, [lines]);

  const data = useMemo(
    () => rows.map((l, i) => ({
      id: i,
      item: l.item ?? '',
      desc: l.desc ?? '',
      quantity: l.quantity ?? '',
      rate: l.rate != null ? money(l.rate) : '',
      amount: l.amount != null ? money(l.amount) : '',
    })),
    [rows]
  );

  const handleCellChange = useCallback((rowId: number, column: string, value: string) => {
    if (column !== 'desc' && column !== 'quantity' && column !== 'rate') return;
    setRows((prev) => {
      const next = prev.map((l, i) => {
        if (i !== rowId) return l;
        if (column === 'desc') return { ...l, desc: value };
        const num = value === '' ? null : Number(value);
        const updated = { ...l, [column]: Number.isFinite(num as number) ? num : null };
        // Amount recomputes from quantity * rate the same way QB does — kept
        // in sync locally so the grid/footer reflect the edit immediately,
        // rather than waiting on QB's own EstimateModRs to confirm it.
        if (updated.quantity != null && updated.rate != null) {
          updated.amount = Math.round(updated.quantity * updated.rate * 100) / 100;
        }
        return updated;
      });
      onChange?.(next);
      return next;
    });
  }, [onChange]);

  const subtotal = useMemo(() => rows.reduce((sum, l) => sum + (l.amount ?? 0), 0), [rows]);
  const grandTotal = total != null ? Number(total) : subtotal;

  return (
    <>
      <EditableDataGrid
        data={data}
        columns={readOnly ? COLUMNS_READONLY : COLUMNS}
        onCellChange={readOnly ? undefined : handleCellChange}
        hideAddButton
        hideDeleteColumn
        emptyMessage="No line items"
      />
      <Box sx={{ display: 'flex', mt: 1 }}>
        <Box sx={{ width: `calc(${WIDTHS.item} + ${WIDTHS.desc} + ${WIDTHS.quantity})` }} />
        <Box sx={{ width: WIDTHS.rate, pl: '12px', pr: '12px' }}>
          <Typography variant="subtitle2" align="right">Total</Typography>
        </Box>
        <Box sx={{ width: WIDTHS.amount, pl: '12px', pr: '12px' }}>
          <Typography variant="subtitle2" align="left">{money(grandTotal)}</Typography>
        </Box>
      </Box>
    </>
  );
};

export default EstimateLinesGrid;
