import React, { useMemo } from 'react';
import { BaseList } from '@meterit/framework-frontend/components/list';
import type { ColumnDefinition } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { renderChipList, type ChipItem } from '@meterit/framework-frontend/components/list/utils/renderHelpers';
import { Box, IconButton, Tooltip } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useUsersEnhanced } from './usersStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission, type User } from '../../types/auth';

/**
 * Data-hygiene badges, one per gap. Both conditions used to be counted up into
 * a "User data gaps" dashboard card; they live here instead, on the rows they
 * actually describe, so the fix is one click away rather than a count to go
 * hunting through.
 */
function getUserStatusChips(user: User): ChipItem[] {
  const chips: ChipItem[] = [];

  // No role resolves to no permissions of its own — middleware.ts COALESCEs
  // these rows onto the Sales Rep role so they aren't locked out of the app
  // entirely, which means the row works but not as anyone configured it.
  if (user.role_id == null) {
    chips.push({
      label: 'Missing Role',
      variant: 'error',
      title: 'No role set — this user silently falls back to Sales Rep permissions.',
    });
  }

  // No equivalent fallback: orders/commissions key off the linked QB rep, so
  // an unlinked user simply attributes to nobody.
  if (user.qb_sales_rep_id == null) {
    chips.push({
      label: 'Missing QB Sales Rep',
      variant: 'warning',
      title: 'Not linked to a QuickBooks sales rep — commission attribution and own-scoped order visibility will not work.',
    });
  }

  return chips;
}

// Mirrors each chip's own `title`. A clean row shows no chip at all, so without
// this there's no way to learn what the column can say (same reasoning as
// OrderList's status legend).
const STATUS_LEGEND: { label: string; description: string }[] = [
  { label: 'Missing Role', description: 'No role set — this user silently falls back to Sales Rep permissions.' },
  { label: 'Missing QB Sales Rep', description: 'Not linked to a QuickBooks sales rep — commission attribution and own-scoped order visibility will not work.' },
];

function StatusColumnInfo() {
  return (
    <Tooltip
      title={
        <Box sx={{ p: 0.5 }}>
          {STATUS_LEGEND.map((s) => (
            <Box key={s.label} sx={{ mb: 0.75, fontSize: '0.8rem' }}>
              <Box component="span" sx={{ fontWeight: 700 }}>{s.label}</Box>
              {' — '}{s.description}
            </Box>
          ))}
        </Box>
      }
    >
      <IconButton
        size="small"
        onClick={(e) => e.stopPropagation()}
        aria-label="What each status means"
        sx={{ ml: 0.5, p: 0.25 }}
      >
        <InfoOutlinedIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
  );
}

const STATUS_CHIPS_COLUMN: ColumnDefinition<User> = {
  key: 'status_chips' as keyof User,
  label: 'Statuses',
  headerExtra: <StatusColumnInfo />,
  sortable: false,
  responsive: 'always-show',
  render: (_value, row) => renderChipList(getUserStatusChips(row)),
};

interface UserListProps {
  onUserEdit?: (user: User) => void;
  onUserCreate?: () => void;
  authContext?: { checkPermission: (p: any) => boolean; user: any };
}

export const UserList: React.FC<UserListProps> = ({ onUserEdit, onUserCreate, authContext: authProp }) => {
  const realAuth = useAuth();
  const auth = authProp ?? realAuth;
  const { schema } = useSchema('user');

  const columns = useMemo(() => {
    if (!schema) return [];
    const cols = generateColumnsFromSchema<User>(schema.formFields, {
      fieldOrder: ['first_name', 'last_name', 'email', 'agency_name', 'role_id'],
      responsive: 'hide-mobile',
    });
    // Right after the two columns it reads (role_id, then the unordered
    // qb_sales_rep_id the generator appends), so a gap and its empty cell sit
    // side by side.
    const repIdx = cols.findIndex((col) => col.key === 'qb_sales_rep_id');
    const roleIdx = cols.findIndex((col) => col.key === 'role_id');
    const anchor = repIdx !== -1 ? repIdx : roleIdx;
    cols.splice(anchor === -1 ? cols.length : anchor + 1, 0, STATUS_CHIPS_COLUMN);
    return cols;
  }, [schema]);

  const filters = useMemo(() => {
    if (!schema) return [];
    return generateFiltersFromSchema(schema.formFields);
  }, [schema]);

  const baseList = useBaseList<User, any>({
    entityName: 'user',
    entityNamePlural: 'users',
    useStore: useUsersEnhanced,
    features: {
      allowCreate: true,
      allowEdit: true,
      allowDelete: true,
      allowBulkActions: false,
      allowExport: false,
      allowImport: false,
      allowSearch: true,
      allowFilters: true,
      allowStats: false,
    },
    permissions: {
      create: Permission.USER_CREATE,
      update: Permission.USER_UPDATE,
      delete: Permission.USER_DELETE,
    },
    columns,
    filters,
    onEdit: onUserEdit,
    onCreate: onUserCreate,
    authContext: auth,
  });

  return (
    <div className="user-list">
      <BaseList
        title="Users"
        filters={baseList.renderFilters()}
        onCreateClick={baseList.canCreate ? baseList.handleCreate : undefined}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No users found."
        onEdit={baseList.handleEdit}
        onDelete={baseList.canDelete ? baseList.handleDelete : undefined}
        pagination={baseList.pagination}
        sortBy={baseList.sortBy}
        sortOrder={baseList.sortOrder}
      />
      {baseList.renderDeleteConfirmation()}
    </div>
  );
};

export default UserList;
