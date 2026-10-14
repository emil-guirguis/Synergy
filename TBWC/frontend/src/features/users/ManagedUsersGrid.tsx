import React from 'react';
import { ChildRowsGrid } from '@meterit/framework-frontend/components/datagrid/';
import { managedUsersApi } from '../../services/userManagersService';
import { tbwcReferenceSearch } from '../../shared/referenceSearch';
import { useAuth } from '../../hooks/useAuth';

interface ManagedUsersGridProps {
  /** The manager — the user record this form is editing. Undefined until the record is saved. */
  managerId?: string;
}

/**
 * "Manages" tab on the Users form — who this user's order list also shows
 * orders for (orders.ts unions sales_rep_list_id across the set). Flat, one
 * level: a picked user's own managed users are not pulled in transitively.
 *
 * Driven by userGridManagerSchema.ts (framework ChildRowsGrid): each row
 * saves itself, and Add/Remove follow userGridManager:create/delete — set per
 * role under Settings > Roles > User > Manages.
 */
export const ManagedUsersGrid: React.FC<ManagedUsersGridProps> = ({ managerId }) => {
  const { scopeOf } = useAuth();

  if (!managerId) {
    return <p style={{ color: 'var(--mui-palette-text-secondary, #666)' }}>Save this user before assigning who they manage.</p>;
  }

  return (
    <ChildRowsGrid
      schemaName="userGridManager"
      parentId={managerId}
      api={managedUsersApi}
      search={tbwcReferenceSearch}
      canCreate={scopeOf('userGridManager:create') !== null}
      canDelete={scopeOf('userGridManager:delete') !== null}
    />
  );
};

export default ManagedUsersGrid;
