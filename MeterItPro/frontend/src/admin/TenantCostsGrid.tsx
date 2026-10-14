import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { EditableDataGrid, type GridColumn, useGridToast, useUnsavedRow } from '@meterit/framework-frontend/components/datagrid/';
import { listTenantCosts, createTenantCost, updateTenantCost, removeTenantCost, type TenantCost } from './adminService';

interface Props { tenantId: number; }

const COST_TYPES     = ['subscription', 'setup', 'support', 'hardware', 'training', 'other'];
const BILLING_CYCLES = ['monthly', 'quarterly', 'annual', 'one-time'];

const NEW_ROW_DEFAULTS = {
  description:    '',
  cost_type:      'subscription',
  billing_cycle:  'monthly',
  amount:         '0',
  effective_date: '',
  notes:          '',
  active:         'Active',
};

const COLUMNS: GridColumn[] = [
  { key: 'description',    label: 'Description',    type: 'text',   width: '25%' },
  { key: 'cost_type',      label: 'Type',           type: 'select', width: '12%', options: COST_TYPES },
  { key: 'billing_cycle',  label: 'Billing',        type: 'select', width: '12%', options: BILLING_CYCLES },
  { key: 'amount',         label: 'Amount ($)',      type: 'number', width: '10%' },
  { key: 'effective_date', label: 'Effective Date',  type: 'text',   width: '12%' },
  { key: 'notes',          label: 'Notes',          type: 'text',   width: '17%' },
  { key: 'active',         label: 'Status',         type: 'select', width: '8%',  options: ['Active', 'Inactive'] },
];

function toApiValue(column: string, value: string): any {
  if (column === 'amount')         return parseFloat(value) || 0;
  if (column === 'active')         return value === 'Active';
  if (column === 'effective_date') return value.trim() || null;
  if (column === 'notes')          return value.trim() || null;
  return value;
}

function toGridRow(item: TenantCost): Record<string, any> {
  return {
    id:             item.tenant_cost_id,
    description:    item.description,
    cost_type:      item.cost_type,
    billing_cycle:  item.billing_cycle,
    amount:         String(item.amount),
    effective_date: item.effective_date ?? '',
    notes:          item.notes ?? '',
    active:         item.active ? 'Active' : 'Inactive',
  };
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

export const TenantCostsGrid: React.FC<Props> = ({ tenantId }) => {
  const [items, setItems]     = useState<TenantCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const { toastProps, showSuccess, showError } = useGridToast();

  const {
    unsavedRow,
    itemsRef,
    hasUnsaved,
    handleAddRow,
    handleRowDelete,
    updateUnsavedField,
    clearUnsaved,
    getActualRowId,
  } = useUnsavedRow(items, NEW_ROW_DEFAULTS);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listTenantCosts(tenantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const gridData = useMemo(() => {
    const rows: Record<string, any>[] = [];
    if (unsavedRow) {
      rows.push({ id: 'unsaved', ...unsavedRow, _isUnsaved: true });
    }
    items.forEach(item => rows.push(toGridRow(item)));
    return rows;
  }, [items, unsavedRow]);

  const totalMonthly = useMemo(() =>
    items.filter(i => i.active).reduce((sum, i) => {
      if (i.billing_cycle === 'monthly')   return sum + Number(i.amount);
      if (i.billing_cycle === 'quarterly') return sum + Number(i.amount) / 3;
      if (i.billing_cycle === 'annual')    return sum + Number(i.amount) / 12;
      return sum;
    }, 0),
  [items]);

  const handleSaveUnsaved = useCallback(async () => {
    if (!unsavedRow?.description?.trim()) {
      showError('Description is required');
      return;
    }
    try {
      await createTenantCost(tenantId, {
        description:    unsavedRow.description,
        cost_type:      unsavedRow.cost_type,
        billing_cycle:  unsavedRow.billing_cycle,
        amount:         parseFloat(unsavedRow.amount) || 0,
        effective_date: unsavedRow.effective_date.trim() || null,
        notes:          unsavedRow.notes.trim() || null,
        active:         unsavedRow.active === 'Active',
      });
      clearUnsaved();
      showSuccess('Cost added');
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Save failed');
    }
  }, [unsavedRow, tenantId, clearUnsaved, showSuccess, showError, load]);

  const handleCellChange = useCallback((rowId: number, column: string, value: string) => {
    if (hasUnsaved && rowId === 0) {
      updateUnsavedField(column, value);
      return;
    }
    const actualRowId = getActualRowId(rowId);
    setItems(prev => {
      const updated = [...prev];
      if (updated[actualRowId]) {
        updated[actualRowId] = { ...updated[actualRowId], [column]: toApiValue(column, value) };
      }
      return updated;
    });
  }, [hasUnsaved, getActualRowId, updateUnsavedField]);

  const handleCellBlur = useCallback(async (rowId: number, column: string, value: string) => {
    if (hasUnsaved && rowId === 0) return;
    const actualRowId = getActualRowId(rowId);
    const item = itemsRef.current[actualRowId];
    if (!item) return;
    try {
      await updateTenantCost(tenantId, item.tenant_cost_id, { [column]: toApiValue(column, value) });
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Update failed');
      await load();
    }
  }, [hasUnsaved, getActualRowId, itemsRef, tenantId, showError, load]);

  const handleConfirmDelete = useCallback(async (rowId: number) => {
    const actualRowId = getActualRowId(rowId);
    const item = itemsRef.current[actualRowId];
    if (!item) return;
    await removeTenantCost(tenantId, item.tenant_cost_id);
    await load();
  }, [getActualRowId, itemsRef, tenantId, load]);

  return (
    <Box>
      {items.length > 0 && (
        <Box px={1} pt={1}>
          <Typography variant="caption" color="text.secondary">
            {formatCurrency(totalMonthly)}/mo effective
          </Typography>
        </Box>
      )}
      <EditableDataGrid
        title="Costs"
        data={gridData}
        columns={COLUMNS}
        loading={loading}
        error={error}
        onRetry={load}
        onRowAdd={handleAddRow}
        onRowDelete={(rowId) => { handleRowDelete(rowId); }}
        onRowSave={(rowId) => { if (rowId === 0 && unsavedRow) void handleSaveUnsaved(); }}
        onRowCancel={(rowId) => { if (rowId === 0) clearUnsaved(); }}
        onCellChange={handleCellChange}
        onCellBlur={(rowId, column, value) => { void handleCellBlur(rowId, column, String(value)); }}
        emptyMessage="No cost entries yet"
        addButtonLabel="Cost"
        showDeleteConfirmation
        onConfirmDelete={handleConfirmDelete}
        deleteConfirmTitle="Delete Cost"
        deleteConfirmMessage="Delete this cost entry?"
        {...toastProps}
      />
    </Box>
  );
};
