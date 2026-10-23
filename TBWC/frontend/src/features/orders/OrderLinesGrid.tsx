/**
 * Read-only QB line items (order or invoice) — synced into the parent's
 * `lines` jsonb column, so there's no separate fetch and no per-row saving.
 *
 * Columns come from the child-row schema named in `schemaName`
 * (orderGridLine / invoiceGridLine) and from that grant's per-role column
 * visibility — never a column list in this file. Untick Rate in Settings >
 * Roles > Order > Line Items > Columns and the column goes, the same way it
 * does in the schema-driven ChildRowsGrid; the API already redacts the field
 * out of every row (orders.ts/invoices.ts applyEmbeddedGrid), so a hardcoded
 * list could only ever render it blank.
 *
 * Widths come from each column's type via the framework's weightedWidths, so
 * dropping a column re-spreads the rest instead of leaving them squeezed into
 * part of the table.
 */
import React, { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { EditableDataGrid, weightedWidths, type GridColumn } from '@meterit/framework-frontend/components/datagrid/';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import { formatCurrency } from '@meterit/framework-frontend/utils';
import { useAuth } from '../../hooks/useAuth';
import type { OrderLine } from '../../types/order';

interface OrderLinesGridProps {
  lines: OrderLine[] | null;
  /** Child-row schema driving the columns: 'orderGridLine' or 'invoiceGridLine'. */
  schemaName: string;
  /** Order.total (QB's TotalAmount) — shown as-is; falls back to the summed line amounts if absent.
   *  Doesn't include freight (QB never puts it on the sales order — see `freight`). */
  total?: number | string | null;
  /** Denormalised from the linked invoice's FREIGHT line item (see orderInvoiceStatus.ts).
   *  Added into Grand Total since `total` above never includes it. Always shown as its
   *  own row, even at $0, so its absence doesn't read as a missing row. */
  freight?: number | string | null;
}

// pg returns NUMERIC columns (order.total) as strings, not numbers — formatCurrency coerces.
const money = (n: number | string) => formatCurrency(n);

/** The field summed in the footer; no footer at all when the role can't see it. */
const TOTAL_FIELD = 'amount';

export const OrderLinesGrid: React.FC<OrderLinesGridProps> = ({ lines, schemaName, total, freight }) => {
  const { schema } = useSchema(schemaName);
  const { isFieldVisible } = useAuth();
  const rows = lines ?? [];

  const columns = useMemo<GridColumn[]>(() => {
    if (!schema) return [];
    const fields = Object.entries(schema.formFields)
      .filter(([, def]) => (def as any).showOn?.includes('list'))
      .filter(([name]) => isFieldVisible(`${schemaName}:read`, name));
    // Widths from the field types (framework weightedWidths), so any subset of
    // columns still fills the table instead of bunching up on the left.
    const widths = weightedWidths(fields.map(([, def]) => (def as any).type));
    return fields.map(([name, def], i) => ({
      key: name,
      label: (def as any).label || name,
      editable: false,
      width: widths[i],
    }));
  }, [schema, schemaName, isFieldVisible]);

  const currencyFields = useMemo(
    () => new Set(
      Object.entries(schema?.formFields ?? {})
        .filter(([, def]) => (def as any).type === 'currency')
        .map(([name]) => name)
    ),
    [schema]
  );

  const data = useMemo(
    () => rows.map((line, i) => {
      const row: Record<string, unknown> = { id: i };
      for (const col of columns) {
        const value = (line as any)[col.key];
        row[col.key] = value == null ? '' : currencyFields.has(col.key) ? money(value) : value;
      }
      return row;
    }),
    [rows, columns, currencyFields]
  );

  const subtotal = useMemo(() => rows.reduce((sum, l) => sum + (l.amount ?? 0), 0), [rows]);
  const freightAmount = freight != null ? Number(freight) : 0;
  // `total` (QB's own order TotalAmount) never includes freight — it's added
  // at invoicing time, after the order total is set — so it has to be summed
  // in here rather than already being part of `total`.
  const grandTotal = (total != null ? Number(total) : subtotal) + freightAmount;

  // The footer's figures sit under the money column they're totalling, so it
  // only makes sense while that column is there.
  const totalCol = columns.findIndex((c) => c.key === TOTAL_FIELD);
  const footerRows = totalCol < 0 ? [] : [
    { label: 'Subtotal', value: subtotal, variant: 'body2' as const },
    { label: 'Freight', value: freightAmount, variant: 'body2' as const },
    { label: 'Total', value: grandTotal, variant: 'subtitle2' as const },
  ];
  // Label goes in the column before the total's, numbers under the total
  // itself; everything left of those is spacer.
  const labelWidth = totalCol > 0 ? columns[totalCol - 1].width : undefined;
  const spacerWidths = columns.slice(0, Math.max(totalCol - 1, 0)).map((c) => c.width);

  // Schema still loading (or named wrong): render nothing rather than flash an
  // empty, column-less table.
  if (columns.length === 0) return null;

  return (
    <>
      <EditableDataGrid
        title="Line Items"
        data={data}
        columns={columns}
        hideAddButton
        hideDeleteColumn
        emptyMessage="No line items"
      />
      {footerRows.map(({ label, value, variant }) => (
        <Box key={label} sx={{ display: 'flex', mt: label === 'Subtotal' ? 1 : 0.5 }}>
          <Box sx={{ width: `calc(${spacerWidths.join(' + ') || '0%'})` }} />
          <Box sx={{ width: labelWidth, pl: '12px', pr: '12px', ml: labelWidth ? 0 : 'auto' }}>
            <Typography variant={variant} color={variant === 'body2' ? 'text.secondary' : undefined} align="right">
              {label}
            </Typography>
          </Box>
          <Box sx={{ width: columns[totalCol].width, pl: '12px', pr: '12px' }}>
            <Typography variant={variant} align="left">{money(value)}</Typography>
          </Box>
        </Box>
      ))}
    </>
  );
};

export default OrderLinesGrid;
