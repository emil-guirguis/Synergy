import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { EditableDataGrid, type GridColumn, useGridToast, useUnsavedRow } from '@meterit/framework-frontend/components/datagrid/';
import {
  listEquipment, addEquipment, updateEquipment, removeEquipment, listDeviceCatalog,
  type TenantEquipment, type DeviceCatalog,
} from './adminService';

interface Props {
  tenantId: number;
}

export const TenantEquipmentGrid: React.FC<Props> = ({ tenantId }) => {
  const [items, setItems]     = useState<TenantEquipment[]>([]);
  const [catalog, setCatalog] = useState<DeviceCatalog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const { toastProps, showSuccess, showError } = useGridToast();

  const {
    unsavedRow,
    unsavedRef,
    itemsRef,
    hasUnsaved,
    handleAddRow,
    handleRowDelete,
    updateUnsavedField,
    clearUnsaved,
    getActualRowId,
  } = useUnsavedRow(items, { device: '', quantity: '1', price: '0' });

  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eq, cat] = await Promise.all([listEquipment(tenantId), listDeviceCatalog()]);
      setItems(eq);
      setCatalog(cat);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  // Map display string → full catalog entry (device_id + default_price)
  const deviceDisplayMap = useMemo(() => {
    const map = new Map<string, DeviceCatalog>();
    catalog.forEach(d => map.set(`${d.manufacturer} — ${d.model_number} (${d.type})`, d));
    return map;
  }, [catalog]);

  const columns: GridColumn[] = useMemo(() => [
    {
      key: 'device',
      label: 'Device',
      editable: true,
      type: 'select',
      // For the unsaved row (index 0): show available catalog entries.
      // For existing rows: return null (falsy) so the floating select never opens.
      options: (rowId: number): string[] => {
        if (unsavedRef.current && rowId === 0) {
          return catalogRef.current
            .filter(d => !itemsRef.current.some(i => i.device_id === d.device_id))
            .map(d => `${d.manufacturer} — ${d.model_number} (${d.type})`);
        }
        return null as unknown as string[];
      },
      width: '50%',
    },
    { key: 'quantity', label: 'Qty',           type: 'number', width: '10%' },
    { key: 'price',    label: 'Price ($)',     type: 'number', width: '15%' },
    { key: 'extended', label: 'Extended ($)',  type: 'number', editable: false, width: '15%' },
  ], [unsavedRow, items]);

  const gridData = useMemo(() => {
    const rows: Record<string, any>[] = [];
    if (unsavedRow) {
      const qty = parseFloat(unsavedRow.quantity) || 0;
      const prc = parseFloat(unsavedRow.price) || 0;
      rows.push({ id: 'unsaved', device: unsavedRow.device, quantity: unsavedRow.quantity, price: unsavedRow.price, extended: String((qty * prc).toFixed(2)), _isUnsaved: true });
    }
    items.forEach(item => rows.push({
      id:       item.tenant_device_id,
      device:   `${item.manufacturer} — ${item.model_number} (${item.type})`,
      quantity: String(item.quantity),
      price:    String(item.price),
      extended: String((item.quantity * item.price).toFixed(2)),
    }));
    return rows;
  }, [items, unsavedRow]);

  const handleSaveUnsaved = useCallback(async () => {
    if (!unsavedRow?.device) {
      showError('Select a device first');
      return;
    }
    const deviceId = deviceDisplayMap.get(unsavedRow.device)?.device_id;
    if (!deviceId) { showError('Invalid device selection'); return; }
    try {
      await addEquipment(tenantId, deviceId, Math.max(1, parseInt(unsavedRow.quantity, 10) || 1), Math.max(0, parseFloat(unsavedRow.price) || 0));
      clearUnsaved();
      showSuccess('Device added');
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Save failed');
    }
  }, [unsavedRow, deviceDisplayMap, tenantId, clearUnsaved, showSuccess, showError, load]);

  const handleCellChange = useCallback((rowId: number, column: string, value: string) => {
    if (hasUnsaved && rowId === 0) {
      updateUnsavedField(column, value);
      if (column === 'device') {
        const dev = deviceDisplayMap.get(value);
        if (dev) updateUnsavedField('price', String(dev.default_price));
      }
      return;
    }
    const actualRowId = getActualRowId(rowId);
    setItems(prev => {
      const updated = [...prev];
      if (updated[actualRowId] && (column === 'quantity' || column === 'price')) {
        updated[actualRowId] = {
          ...updated[actualRowId],
          [column]: column === 'quantity' ? parseInt(value, 10) || 1 : parseFloat(value) || 0,
        };
      }
      return updated;
    });
  }, [hasUnsaved, getActualRowId, updateUnsavedField, deviceDisplayMap]);

  const handleCellBlur = useCallback(async (rowId: number, column: string, value: string) => {
    if (hasUnsaved && rowId === 0) return;
    const actualRowId = getActualRowId(rowId);
    const item = itemsRef.current[actualRowId];
    if (!item || (column !== 'quantity' && column !== 'price')) return;
    const newQty   = column === 'quantity' ? Math.max(1, parseInt(value, 10)   || 1) : item.quantity;
    const newPrice = column === 'price'    ? Math.max(0, parseFloat(value)     || 0) : item.price;
    try {
      await updateEquipment(tenantId, item.tenant_device_id, newQty, newPrice);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Update failed');
      await load();
    }
  }, [hasUnsaved, getActualRowId, itemsRef, tenantId, showError, load]);

  const handleConfirmDelete = useCallback(async (rowId: number) => {
    const actualRowId = getActualRowId(rowId);
    const item = itemsRef.current[actualRowId];
    if (!item) return;
    await removeEquipment(tenantId, item.tenant_device_id);
    await load();
  }, [getActualRowId, itemsRef, tenantId, load]);

  return (
    <EditableDataGrid
      title="Equipment"
      data={gridData}
      columns={columns}
      loading={loading}
      error={error}
      onRetry={load}
      onRowAdd={handleAddRow}
      onRowDelete={(rowId) => { handleRowDelete(rowId); }}
      onRowCancel={(rowId) => { handleRowDelete(rowId); }}
      onRowSave={(rowId) => { if (rowId === 0 && unsavedRow) void handleSaveUnsaved(); }}
      onCellChange={handleCellChange}
      onCellBlur={(rowId, column, value) => { void handleCellBlur(rowId, column, String(value)); }}
      emptyMessage="No devices added yet"
      addButtonLabel="Device"
      showDeleteConfirmation
      onConfirmDelete={handleConfirmDelete}
      deleteConfirmTitle="Remove Device"
      deleteConfirmMessage="Remove this device from the client's equipment list?"
      {...toastProps}
    />
  );
};
