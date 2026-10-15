/**
 * Settings — org info + system config (admin-only). Built on the framework's
 * base Settings shell/forms; see framework/frontend/components/settings.
 */
import { useCallback, useEffect, useState } from 'react';
import BusinessIcon from '@mui/icons-material/Business';
import TuneIcon from '@mui/icons-material/Tune';
import SecurityIcon from '@mui/icons-material/Security';
import PsychologyIcon from '@mui/icons-material/Psychology';
import DriveFolderUploadIcon from '@mui/icons-material/DriveFolderUpload';
import ScheduleIcon from '@mui/icons-material/Schedule';
import {
  SettingsPageShell,
  OrgInfoForm,
  SystemConfigForm,
  RolesForm,
  type ManagedRole,
  type RoleGrant,
} from '@meterit/framework-frontend/components/settings';
import { getSettings, updateSettings, type CompanySettings } from '../services/settingsService';
import {
  getRoles, getCatalog, createRole, renameRole, saveGrants, deleteRole,
} from '../services/rolesService';
import AiMemoryPanel from '../features/aiMemory/AiMemoryPanel';
import ScheduledJobsPanel from '../features/scheduledJobs/ScheduledJobsPanel';
import QuoteImportPanel from '../features/quotes/QuoteImportPanel';
import { NAV, roleOrderFromNav } from '../components/layout/navConfig';
import { useAuth } from '../hooks/useAuth';

const ROLES_TAB_ENABLED = true;

// Derived from the sidebar's own nav (components/layout/navConfig.ts), so a
// new nav item with a requiredPermission just shows up here too — no second
// place to hand-edit. One manual override on top of that:
//
// - QuickBooks: NAV can't express this group at all — its sidebar visibility
//   collapses to a single permission (inventory:read, see navConfig.ts)
//   shared by three unrelated catalog modules, plus qbSync (a separate
//   top-level nav item) that belongs in this group in the roles tree but not
//   in the sidebar dropdown.
// (Per-record file attachments used to be one flat `document` module nested
// under Utilities here; each module's Documents grid is now its own child
// node — Order > Documents, Quote > Documents, ... — so nothing to place.)
const ROLE_ORDER = roleOrderFromNav(NAV).map((node) => {
  if (typeof node === 'string') return node;
  if (node.label === 'QuickBooks') {
    return { label: 'QuickBooks', modules: ['customer', 'inventory', 'payment', 'qbsync'] };
  }
  return node;
});

export default function SettingsPage() {
  const { scopeOf } = useAuth();
  // Quote Import writes quote_line/document rows directly (no form UI, no
  // own-scope narrowing possible) — gated on the same grant QuoteForm itself
  // uses to decide admin vs. read-only (quote:write), not setting:read alone.
  const canImportQuotes = scopeOf('quote:write') !== null;
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [roles, setRoles] = useState<ManagedRole[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSettings(await getSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);


  // Roles are only readable with role:read, so a 403 here is a normal outcome
  // for a non-admin rather than a failure worth surfacing as a page error —
  // the section just stays empty for them.
  const loadRoles = useCallback(async () => {
    try {
      const [items, permissions] = await Promise.all([getRoles(), getCatalog()]);
      setRoles(items);
      setCatalog(permissions);
      setRolesError(null);
    } catch (e) {
      setRolesError(e instanceof Error ? e.message : 'Failed to load roles');
    }
  }, []);

  useEffect(() => {
    if (ROLES_TAB_ENABLED) loadRoles();
  }, [loadRoles]);

  /** Every role mutation re-reads the list: grants are stored server-side and
   *  the response doesn't carry the recomputed user counts. */
  const withRoleRefresh = async (action: () => Promise<void>, message: string) => {
    setLoading(true);
    setRolesError(null);
    try {
      await action();
      await loadRoles();
      setSuccessMessage(message);
    } catch (e) {
      setRolesError(e instanceof Error ? e.message : 'Failed to save role');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (successMessage) {
      const t = setTimeout(() => setSuccessMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [successMessage]);

  const handleOrgInfoChange = (field: string, value: any) => {
    if (!settings) return;
    if (field.includes('.')) {
      const [parent, child] = field.split('.');
      setSettings({
        ...settings,
        [parent]: { ...(settings[parent as keyof CompanySettings] as any), [child]: value },
      });
    } else {
      setSettings({ ...settings, [field]: value } as CompanySettings);
    }
  };

  const handleSystemConfigChange = (field: string, value: any) => {
    if (!settings) return;
    setSettings({ ...settings, systemConfig: { ...settings.systemConfig, [field]: value } });
  };

  const save = async (updates: Partial<CompanySettings>, message: string) => {
    setLoading(true);
    setError(null);
    try {
      setSettings(await updateSettings(updates));
      setSuccessMessage(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setLoading(false);
    }
  };

  if (!settings) {
    return (
      <SettingsPageShell
        title="Settings"
        subtitle="Company information and preferences"
        error={error}
        sections={[{ key: 'organization', label: 'Organization', icon: <BusinessIcon fontSize="small" />, description: '', content: null }]}
      />
    );
  }

  return (
    <SettingsPageShell
      title="Settings"
      subtitle="Company information and preferences"
      successMessage={successMessage}
      error={error}
      sections={[
        {
          key: 'organization',
          label: 'Organization',
          icon: <BusinessIcon fontSize="small" />,
          description: 'Company info shown on quotes, orders, and documents.',
          content: (
            <OrgInfoForm
              values={settings}
              onChange={handleOrgInfoChange}
              onSubmit={() => save({ name: settings.name, address: settings.address, contactInfo: settings.contactInfo }, 'Company information saved successfully')}
              onCancel={load}
              loading={loading}
              error={error}
            />
          ),
        },
        {
          key: 'systemConfig',
          label: 'System Config',
          icon: <TuneIcon fontSize="small" />,
          description: 'System configuration and operational settings.',
          content: (
            <SystemConfigForm
              values={settings.systemConfig}
              onChange={handleSystemConfigChange}
              onSubmit={() => save({ systemConfig: settings.systemConfig }, 'System configuration saved successfully')}
              onCancel={load}
              loading={loading}
              error={error}
            />
          ),
        },
        ...(ROLES_TAB_ENABLED ? [{
          key: 'roles',
          label: 'Roles',
          icon: <SecurityIcon fontSize="small" />,
          description: 'What each role may do. Add a role and tick its permissions.',
          content: (
            <RolesForm
              roles={roles}
              catalog={catalog}
              order={ROLE_ORDER}
              loading={loading}
              error={rolesError}
              onCreate={(input) => withRoleRefresh(() => createRole(input), `Role "${input.name}" created`)}
              onRename={(roleId, name) => withRoleRefresh(() => renameRole(roleId, name), 'Role renamed')}
              onSaveGrants={(roleId: number, grants: RoleGrant[]) =>
                withRoleRefresh(() => saveGrants(roleId, grants), 'Permissions saved')}
              onDelete={(roleId) => withRoleRefresh(() => deleteRole(roleId), 'Role deleted')}
            />
          ),
        }] : []),
        {
          key: 'aiMemory',
          label: 'AI Memory',
          icon: <PsychologyIcon fontSize="small" />,
          description: 'Durable facts the AI chat has taught itself and saved for future conversations.',
          content: <AiMemoryPanel />,
        },
        {
          key: 'scheduledJobs',
          label: 'Scheduled Jobs',
          icon: <ScheduleIcon fontSize="small" />,
          description: 'Cron job run history, and who the QuickBooks connection alert notifies.',
          content: <ScheduledJobsPanel />,
        },
        ...(canImportQuotes ? [{
          key: 'quoteImport',
          label: 'Quote Import',
          icon: <DriveFolderUploadIcon fontSize="small" />,
          description: 'Rerunnable fix-up for quotes already in the system — missing/corrupt documents, missing line items and totals.',
          content: <QuoteImportPanel />,
        }] : []),
      ]}
    />
  );
}
