import React from 'react';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { ImpersonateButton } from '@meterit/framework-frontend/components/auth';
import { useUsersEnhanced } from './usersStore';
import { ManagedUsersGrid } from './ManagedUsersGrid';
import { useAuth } from '../../hooks/useAuth';
import { authService } from '../../services/authService';
import type { User } from '../../types/auth';

interface UserFormProps {
  user?: User;
  onCancel: () => void;
  loading?: boolean;
}

/**
 * Schema-driven user form. BaseForm fetches the `user` schema (GET /api/schema/user)
 * and renders + validates every field; the store handles create/update via REST.
 */
export const UserForm: React.FC<UserFormProps> = ({ user, onCancel, loading = false }) => {
  const users = useUsersEnhanced();
  const { user: currentUser } = useAuth();

  return (
    <BaseForm
      schemaName="user"
      entity={user}
      store={users}
      onCancel={onCancel}
      className="user-form"
      loading={loading}
      showTabs={true}
      // managed_users is UI-only (see usersSchema.ts) — it saves itself via
      // ManagedUsersGrid's own API calls, so it's excluded here the same way
      // OrderForm excludes 'lines'/'documents'.
      fieldsToClean={['managed_users']}
      renderCustomField={(fieldName) => {
        if (fieldName === 'managed_users') return <ManagedUsersGrid managerId={user?.id} />;
        if (fieldName === 'impersonate_actions' && user?.id) {
          return (
            <ImpersonateButton
              currentUserEmail={currentUser?.email}
              // Server-gated: /api/schema/user only serves this section to the
              // .dev.vars IMPERSONATE_ALLOWED_EMAIL caller.
              allowedEmail={null}
              targetUserId={user.id}
              currentUserId={currentUser?.id}
              targetLabel={user.first_name || user.email}
              onActivate={async () => {
                await authService.impersonate(user.id, user.email || 'this user');
                window.location.reload();
              }}
            />
          );
        }
        return null;
      }}
    />
  );
};

export default UserForm;
