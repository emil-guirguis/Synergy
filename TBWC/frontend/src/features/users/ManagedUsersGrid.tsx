import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditableDataGrid, type GridColumn, useGridToast, useUnsavedRow } from '@meterit/framework-frontend/components/datagrid/';
import {
  getManagedUsers, addManagedUser, removeManagedUser, searchUsers, type ManagedUserRow,
} from '../../services/userManagersService';
import type { User } from '../../types/auth';

interface ManagedUsersGridProps {
  /** The manager — the user record this form is editing. Undefined until the record is saved. */
  managerId?: string;
}

const displayName = (u: User) => `${u.first_name} ${u.last_name}${u.email ? ` (${u.email})` : ''}`;

/**
 * "Manages" tab on the Users form — who this user's order list also shows
 * orders for (orders.ts unions sales_rep_list_id across the set). Flat, one
 * level: a picked user's own managed users are not pulled in transitively.
 *
 * Each row saves itself immediately via /api/user-managers, same as
 * TenantEquipmentGrid — there is no dirty state tied to this form's own Save.
 */
export const ManagedUsersGrid: React.FC<ManagedUsersGridProps> = ({ managerId }) => {
  const [items, setItems] = useState<ManagedUserRow[]>([]);
  const [catalog, setCatalog] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { toastProps, showSuccess, showError } = useGridToast();

  const {
    unsavedRow, unsavedRef, itemsRef, hasUnsaved,
    handleAddRow, handleRowDelete, updateUnsavedField, clearUnsaved, getActualRowId,
  } = useUnsavedRow(items, { user: '' });

  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  const load = useCallback(async () => {
    if (!managerId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [managed, users] = await Promise.all([getManagedUsers(managerId), searchUsers('', 200)]);
      setItems(managed);
      setCatalog(users);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [managerId]);

  useEffect(() => { void load(); }, [load]);

  // Display string -> candidate user, for resolving the select's value back to an id.
  const userDisplayMap = useMemo(() => {
    const map = new Map<string, User>();
    catalog.forEach((u) => map.set(displayName(u), u));
    return map;
  }, [catalog]);

  const columns: GridColumn[] = useMemo(() => [
    {
      key: 'user',
      label: 'User',
      editable: true,
      type: 'select',
      // Only the unsaved row (index 0) opens a picker; existing rows are fixed
      // once saved — removing and re-adding is how you change one.
      options: (rowId: number): string[] => {
        if (unsavedRef.current && rowId === 0) {
          const managedIds = new Set(itemsRef.current.map((i) => i.managed_user_id));
          return catalogRef.current
            .filter((u) => u.id !== managerId && !managedIds.has(u.id))
            .map(displayName);
        }
        return null as unknown as string[];
      },
      width: '70%',
    },
  ], [unsavedRow, items, managerId]);

  const gridData = useMemo(() => {
    const rows: Record<string, any>[] = [];
    if (unsavedRow) rows.push({ id: 'unsaved', user: unsavedRow.user, _isUnsaved: true });
    items.forEach((row) => rows.push({
      id: row.user_manager_id,
      user: `${row.first_name} ${row.last_name}${row.sales_rep_initial ? ` (${row.sales_rep_initial})` : ''}`,
    }));
    return rows;
  }, [items, unsavedRow]);

  const handleSaveUnsaved = useCallback(async () => {
    if (!managerId || !unsavedRow?.user) {
      showError('Select a user first');
      return;
    }
    const picked = userDisplayMap.get(unsavedRow.user);
    if (!picked) { showError('Invalid user selection'); return; }
    try {
      await addManagedUser(managerId, picked.id);
      clearUnsaved();
      showSuccess('User added');
      await load();
    } catch (err: any) {
      showError(err?.message || 'Save failed');
    }
  }, [managerId, unsavedRow, userDisplayMap, clearUnsaved, showSuccess, showError, load]);

  const handleCellChange = useCallback((rowId: number, column: string, value: string) => {
    if (hasUnsaved && rowId === 0) updateUnsavedField(column, value);
  }, [hasUnsaved, updateUnsavedField]);

  const handleConfirmDelete = useCallback(async (rowId: number) => {
    const actualRowId = getActualRowId(rowId);
    const item = itemsRef.current[actualRowId];
    if (!item) return;
    await removeManagedUser(item.user_manager_id);
    await load();
  }, [getActualRowId, itemsRef, load]);

  if (!managerId) {
    return <p style={{ color: 'var(--mui-palette-text-secondary, #666)' }}>Save this user before assigning who they manage.</p>;
  }

  return (
    <EditableDataGrid
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
      emptyMessage="This user doesn't manage anyone yet"
      addButtonLabel="User"
      showDeleteConfirmation
      onConfirmDelete={handleConfirmDelete}
      deleteConfirmTitle="Stop managing user"
      deleteConfirmMessage="Remove this user from the ones they manage? Their orders will no longer show up for this manager."
      {...toastProps}
    />
  );
};

export default ManagedUsersGrid;
