import React, { useMemo } from 'react';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { useUsersEnhanced } from './usersStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission, type User } from '../../types/auth';

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
    return generateColumnsFromSchema<User>(schema.formFields, {
      fieldOrder: ['first_name', 'last_name', 'email', 'agency_name', 'role_id', 'approved', 'is_admin'],
      responsive: 'hide-mobile',
    });
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
        pagination={baseList.pagination}
      />
    </div>
  );
};

export default UserList;
