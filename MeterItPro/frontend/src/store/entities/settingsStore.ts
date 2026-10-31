// Company Settings Store

import type { CompanySettings } from '../../types/entities';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { withApiCall, withTokenRefresh } from '../middleware/apiMiddleware';

// Settings store state interface
interface SettingsStoreState {
  settings: CompanySettings | null;
  loading: boolean;
  error: string | null;
  lastFetch: number | null;
}

// Settings store actions interface
interface SettingsStoreActions {
  fetchSettings: () => Promise<void>;
  updateSettings: (updates: Partial<CompanySettings>) => Promise<void>;
  updateSystemConfig: (config: Partial<CompanySettings['systemConfig']>) => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
  invalidateCache: () => void;
}

// Combined store interface
interface SettingsStore extends SettingsStoreState, SettingsStoreActions {}

// Import auth service for token management
import { authService } from '../../services/authService';

// Real API service for company settings
const settingsService = {
  async getSettings() {
    return withTokenRefresh(async () => {
      const token = authService.getStoredToken();

      const response = await fetch('/api/settings/company', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });


      let result;
      try {
        result = await response.json();
      } catch (e) {
        console.error('Failed to parse response as JSON:', e);
        throw new Error(`Failed to fetch settings: ${response.status} ${response.statusText}`);
      }


      if (!response.ok) {
        throw new Error(result?.message || `Failed to fetch settings: ${response.status}`);
      }

      if (!result.success) {
        throw new Error(result.message || 'Failed to fetch settings');
      }

      return result.data;
    });
  },

  async updateSettings(updates: Partial<CompanySettings>) {
    return withTokenRefresh(async () => {
      const token = authService.getStoredToken();
      const response = await fetch('/api/settings/company', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
      });

      let result;
      try {
        result = await response.json();
      } catch (e) {
        console.error('Failed to parse response as JSON:', e);
        throw new Error(`Failed to update settings: ${response.status} ${response.statusText}`);
      }

      if (!response.ok) {
        throw new Error(result?.message || `Failed to update settings: ${response.status}`);
      }

      if (!result.success) {
        throw new Error(result.message || 'Failed to update settings');
      }

      return result.data;
    });
  }
};



// Initial state
const initialState: SettingsStoreState = {
  settings: null,
  loading: false,
  error: null,
  lastFetch: null,
};

// Create settings store
export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Actions
      fetchSettings: async () => {
        const state = get();

        // Check cache freshness (5 minutes)
        const cacheAge = state.lastFetch ? Date.now() - state.lastFetch : Infinity;
        if (cacheAge < 5 * 60 * 1000 && state.settings) {
          return; // Use cached data
        }

        set({ loading: true, error: null });

        try {
          const settings = await settingsService.getSettings();
          set({ settings: settings as any, loading: false, error: null, lastFetch: Date.now() });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch settings';
          set({ loading: false, error: errorMessage });
          throw error;
        }
      },

      updateSettings: async (updates) => {
        const state = get();
        const originalSettings = state.settings;

        // Optimistic update
        if (originalSettings) {
          set({ settings: { ...originalSettings, ...updates } as any });
        }

        set({ loading: true, error: null });

        try {
          const updatedSettings = await settingsService.updateSettings(updates);
          set({ settings: updatedSettings as any, loading: false, error: null, lastFetch: Date.now() });
        } catch (error) {
          // Rollback optimistic update
          if (originalSettings) {
            set({ settings: originalSettings as any });
          }
          const errorMessage = error instanceof Error ? error.message : 'Failed to update settings';
          set({ loading: false, error: errorMessage });
          throw error;
        }
      },

      updateSystemConfig: async (config) => {
        const state = get();
        if (!state.settings) {
          throw new Error('Settings not loaded');
        }
        const updates = {
          systemConfig: { ...state.settings.systemConfig, ...config },
        };
        return get().updateSettings(updates);
      },

      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),
      reset: () => set({ ...initialState }),
      invalidateCache: () => set({ lastFetch: null }),
    }),
    {
      name: 'settings-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        settings: state.settings,
        lastFetch: state.lastFetch,
      }),
      version: 1,
    }
  )
);

// Enhanced settings hook
export const useSettings = () => {
  const store = useSettingsStore();
  
  return {
    // State
    settings: store.settings,
    loading: store.loading,
    error: store.error,
    
    // Actions
    fetchSettings: store.fetchSettings,
    updateSettings: store.updateSettings,
    updateSystemConfig: store.updateSystemConfig,
    reset: store.reset,
    invalidateCache: store.invalidateCache,
    
    // Computed values
    isLoaded: !!store.settings,
    companyName: store.settings?.name || 'Company',
    timezone: store.settings?.systemConfig?.timezone || 'America/New_York',
    dateFormat: store.settings?.systemConfig?.dateFormat || 'MM/DD/YYYY',
    currency: store.settings?.systemConfig?.currency || 'USD',
  };
};

// Enhanced settings hook with additional functionality
export const useSettingsEnhanced = () => {
  const settings = useSettings();
  
  return {
    ...settings,
    
    // Enhanced actions with notifications
    updateCompanyInfo: async (info: Partial<Pick<CompanySettings, 'name' | 'logo' | 'address' | 'contactInfo'>>) => {
      return withApiCall(
        () => settings.updateSettings(info),
        {
          loadingKey: 'updateCompanyInfo',
          showSuccessNotification: true,
          successMessage: 'Company information updated successfully',
        }
      );
    },
    
    
    updateSystemConfigWithNotification: async (config: Partial<CompanySettings['systemConfig']>) => {
      return withApiCall(
        () => settings.updateSystemConfig(config),
        {
          loadingKey: 'updateSystemConfig',
          showSuccessNotification: true,
          successMessage: 'System configuration updated successfully',
        }
      );
    },
    
    // Feature management
    toggleFeature: async (feature: keyof CompanySettings['features'], enabled: boolean) => {
      if (!settings.settings?.features) return;
      
      const updates = {
        features: { ...settings.settings.features, [feature]: enabled },
      };
      
      return withApiCall(
        () => settings.updateSettings(updates),
        {
          loadingKey: 'toggleFeature',
          showSuccessNotification: true,
          successMessage: `Feature ${enabled ? 'enabled' : 'disabled'} successfully`,
        }
      );
    },
    
    // Integration management
    updateIntegration: async (integration: keyof CompanySettings['integrations'], value: any) => {
      if (!settings.settings?.integrations) return;
      
      const updates = {
        integrations: { ...settings.settings.integrations, [integration]: value },
      };
      
      return withApiCall(
        () => settings.updateSettings(updates),
        {
          loadingKey: 'updateIntegration',
          showSuccessNotification: true,
          successMessage: 'Integration updated successfully',
        }
      );
    },
    
    // Maintenance mode
    toggleMaintenanceMode: async (enabled: boolean) => {
      if (!settings.settings?.systemConfig) return;
      
      return settings.updateSystemConfig({ maintenanceMode: enabled });
    },
    
    // Password policy
    updatePasswordPolicy: async (policy: Partial<CompanySettings['systemConfig']['passwordPolicy']>) => {
      if (!settings.settings?.systemConfig?.passwordPolicy) return;
      
      const updatedPolicy = { ...settings.settings.systemConfig.passwordPolicy, ...policy };
      return settings.updateSystemConfig({ passwordPolicy: updatedPolicy });
    },
    
    // Backup settings
    updateBackupSettings: async (backup: Partial<CompanySettings['systemConfig']['backupSettings']>) => {
      if (!settings.settings?.systemConfig?.backupSettings) return;
      
      const updatedBackup = { ...settings.settings.systemConfig.backupSettings, ...backup };
      return settings.updateSystemConfig({ backupSettings: updatedBackup });
    },
    
    // Validation helpers
    validateSettings: (settingsData: Partial<CompanySettings>) => {
      const errors: string[] = [];
      
      if (settingsData.name && settingsData.name.trim().length < 2) {
        errors.push('Company name must be at least 2 characters long');
      }
      
      if (settingsData.contactInfo?.email && !settingsData.contactInfo.email.includes('@')) {
        errors.push('Invalid email address');
      }
      
      if (settingsData.contactInfo?.phone && settingsData.contactInfo.phone.length < 10) {
        errors.push('Phone number must be at least 10 digits');
      }
      
      if (settingsData.systemConfig?.sessionTimeout && settingsData.systemConfig.sessionTimeout < 5) {
        errors.push('Session timeout must be at least 5 minutes');
      }
      
      return {
        isValid: errors.length === 0,
        errors,
      };
    },
    
    
    // Export/Import settings
    exportSettings: () => {
      if (!settings.settings) return null;
      
      const exportData = {
        ...settings.settings,
        exportedAt: new Date().toISOString(),
        version: '1.0',
      };
      
      return JSON.stringify(exportData, null, 2);
    },
    
    importSettings: async (settingsJson: string) => {
      try {
        const importedSettings = JSON.parse(settingsJson);
        
        // Remove metadata fields
        delete importedSettings.id;
        delete importedSettings.exportedAt;
        delete importedSettings.version;
        delete importedSettings.updatedAt;
        
        return settings.updateSettings(importedSettings);
      } catch (error) {
        throw new Error('Invalid settings file format');
      }
    },
  };
};