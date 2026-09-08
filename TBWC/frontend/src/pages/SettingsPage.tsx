/**
 * Settings — org info + system config (admin-only). Built on the framework's
 * base Settings shell/forms; see framework/frontend/components/settings.
 */
import { useCallback, useEffect, useState } from 'react';
import BusinessIcon from '@mui/icons-material/Business';
import TuneIcon from '@mui/icons-material/Tune';
import {
  SettingsPageShell,
  OrgInfoForm,
  SystemConfigForm,
} from '@meterit/framework-frontend/components/settings';
import { getSettings, updateSettings, type CompanySettings } from '../services/settingsService';

export default function SettingsPage() {
  const [settings, setSettings] = useState<CompanySettings | null>(null);
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
      ]}
    />
  );
}
