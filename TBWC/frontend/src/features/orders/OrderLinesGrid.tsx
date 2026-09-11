import React, { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { EditableDataGrid, type GridColumn } from '@meterit/framework-frontend/components/datagrid/';
import type { OrderLine } from '../../types/order';

interface OrderLinesGridProps {
  lines: OrderLine[] | null;
  /** Order.total (QB's TotalAmount) — shown as-is; falls back to the summed line amounts if absent. */
  total?: number | string | null;
  /** Reps see what was ordered, not what it cost: drops Rate, Amount and the totals footer. */
  hideAmounts?: boolean;
}

// pg returns NUMERIC columns (order.total) as strings, not numbers — Number()
// them first, since String.prototype.toLocaleString() is a silent no-op.
const money = (n: number | string) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Explicit widths so the totals footer below can mirror them exactly and land
// its numbers directly under the Amount column instead of floating at the
// container's right edge.
const WIDTHS = { item: '16%', desc: '40%', quantity: '10%', rate: '14%', amount: '20%' };

const COLUMNS: GridColumn[] = [
  { key: 'item', label: 'Item', editable: false, width: WIDTHS.item },
  { key: 'desc', label: 'Description', editable: false, width: WIDTHS.desc },
  { key: 'quantity', label: 'Qty', editable: false, width: WIDTHS.quantity },
  { key: 'rate', label: 'Rate', editable: false, width: WIDTHS.rate },
  { key: 'amount', label: 'Amount', editable: false, width: WIDTHS.amount },
];

// Without the money columns the remaining three would sit squeezed at 66% of
// the width, so re-spread them across the space Rate/Amount vacate.
const COLUMNS_NO_AMOUNTS: GridColumn[] = [
  { key: 'item', label: 'Item', editable: false, width: '22%' },
  { key: 'desc', label: 'Description', editable: false, width: '64%' },
  { key: 'quantity', label: 'Qty', editable: false, width: '14%' },
];

/** Read-only QB sales-order line items — synced into the `lines` jsonb column, no separate fetch. */
export const OrderLinesGrid: React.FC<OrderLinesGridProps> = ({ lines, total, hideAmounts = false }) => {
  const rows = lines ?? [];
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

  const subtotal = useMemo(() => rows.reduce((sum, l) => sum + (l.amount ?? 0), 0), [rows]);
  const grandTotal = total ?? subtotal;

  return (
    <>
      <EditableDataGrid
        data={data}
        columns={hideAmounts ? COLUMNS_NO_AMOUNTS : COLUMNS}
        hideAddButton
        hideDeleteColumn
        emptyMessage="No line items"
      />
      {(hideAmounts ? [] : [
        { label: 'Subtotal', value: subtotal, variant: 'body2' as const },
        { label: 'Total', value: grandTotal, variant: 'subtitle2' as const },
      ]).map(({ label, value, variant }) => (
        <Box key={label} sx={{ display: 'flex', mt: label === 'Subtotal' ? 1 : 0.5 }}>
          <Box sx={{ width: `calc(${WIDTHS.item} + ${WIDTHS.desc} + ${WIDTHS.quantity})` }} />
          <Box sx={{ width: WIDTHS.rate, pl: '12px', pr: '12px' }}>
            <Typography variant={variant} color={variant === 'body2' ? 'text.secondary' : undefined} align="right">
              {label}
            </Typography>
          </Box>
          <Box sx={{ width: WIDTHS.amount, pl: '12px', pr: '12px' }}>
            <Typography variant={variant} align="left">{money(value)}</Typography>
          </Box>
        </Box>
      ))}
    </>
  );
};

export default OrderLinesGrid;
