import React, { useCallback, useEffect, useState } from 'react';
import { RolesForm, type ManagedRole, type RoleGrant } from '@meterit/framework-frontend/components/settings';
import {
  getRoles, getCatalog, createRole, renameRole, saveGrants, deleteRole,
} from '../../services/rolesService';

/**
 * Settings > Roles. Owns its own data the way SyncServersPanel does, so the
 * Settings page just drops it into its sections array.
 *
 * The roles listed are this tenant's own plus the built-in system ones; the
 * server decides which, and refuses edits to anything outside them.
 */
const RolesPanel: React.FC = () => {
  const [roles, setRoles] = useState<ManagedRole[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [items, permissions] = await Promise.all([getRoles(), getCatalog()]);
      setRoles(items);
      setCatalog(permissions);
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? (e instanceof Error ? e.message : 'Failed to load roles'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Re-read after every mutation: grants live server-side and the responses
   *  don't carry recomputed user counts. */
  const run = async (action: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? (e instanceof Error ? e.message : 'Failed to save role'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <RolesForm
      roles={roles}
      catalog={catalog}
      loading={loading}
      error={error}
      onCreate={(input) => run(() => createRole(input))}
      onRename={(roleId, name) => run(() => renameRole(roleId, name))}
      onSaveGrants={(roleId: number, grants: RoleGrant[]) => run(() => saveGrants(roleId, grants))}
      onDelete={(roleId) => run(() => deleteRole(roleId))}
    />
  );
};

export default RolesPanel;
