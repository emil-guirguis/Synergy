import React, { useState, useEffect } from 'react';
import BusinessIcon from '@mui/icons-material/Business';
import SyncIcon from '@mui/icons-material/Sync';
import TuneIcon from '@mui/icons-material/Tune';
import {
  SettingsPageShell,
  OrgInfoForm,
  SystemConfigForm,
} from '@meterit/framework-frontend/components/settings';
import SyncServersPanel from '../features/syncServers/SyncServersPanel';
import './SettingsPage.css';
import { useSettings } from '../store/entities/settingsStore';

const SettingsPage: React.FC = () => {
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const { settings, loading, error, fetchSettings, updateSettings, updateSystemConfig } = useSettings();

  useEffect(() => {
    fetchSettings();
    // eslint-disable-next-line
  }, []);

  const [localSettings, setLocalSettings] = useState(settings);

  useEffect(() => {
    if (settings) setLocalSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (successMessage) {
      const t = setTimeout(() => setSuccessMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [successMessage]);

  const handleCompanyInfoChange = (field: string, value: any) => {
    if (!localSettings) return;
    if (field.includes('.')) {
      const [parent, child] = field.split('.');
      setLocalSettings({
        ...localSettings,
        [parent]: { ...(localSettings[parent as keyof typeof localSettings] as any), [child]: value },
      });
    } else {
      setLocalSettings({ ...localSettings, [field]: value });
    }
  };

  const handleSystemConfigChange = (field: string, value: any) => {
    if (!localSettings) return;
    setLocalSettings({ ...localSettings, systemConfig: { ...localSettings.systemConfig, [field]: value } });
  };

  const handleCompanyInfoSubmit = async () => {
    if (!localSettings) return;
    try {
      await updateSettings({ name: localSettings.name, address: localSettings.address, contactInfo: localSettings.contactInfo });
      setSuccessMessage('Company information saved successfully');
    } catch (err) {
      console.error('Failed to save company info:', err);
    }
  };

  const handleSystemConfigSubmit = async () => {
    if (!localSettings) return;
    try {
      await updateSystemConfig(localSettings.systemConfig);
      setSuccessMessage('System configuration saved successfully');
    } catch (err) {
      console.error('Failed to save system config:', err);
    }
  };

  const handleCancel = () => setLocalSettings(settings);

  if (!localSettings) {
    return (
      <SettingsPageShell
        title="Settings"
        subtitle="Tenant configuration and preferences"
        error={error}
        sections={[{ key: 'loading', label: 'Organization', icon: <BusinessIcon fontSize="small" />, description: '', content: null }]}
      />
    );
  }

  return (
    <SettingsPageShell
      title="Settings"
      subtitle="Tenant configuration and preferences"
      successMessage={successMessage}
      error={error}
      sections={[
        {
          key: 'organization',
          label: 'Organization',
          icon: <BusinessIcon fontSize="small" />,
          description: 'Tenant-level settings applied to every user in your org.',
          content: (
            <OrgInfoForm
              values={localSettings}
              onChange={handleCompanyInfoChange}
              onSubmit={handleCompanyInfoSubmit}
              onCancel={handleCancel}
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
              values={localSettings.systemConfig}
              onChange={handleSystemConfigChange}
              onSubmit={handleSystemConfigSubmit}
              onCancel={handleCancel}
              loading={loading}
              error={error}
            />
          ),
        },
        {
          key: 'syncServers',
          label: 'Sync Servers',
          icon: <SyncIcon fontSize="small" />,
          description: 'Manage sync servers connected via Cloudflare Tunnel.',
          content: <SyncServersPanel />,
        },
      ]}
    />
  );
};

export default SettingsPage;
