import apiClient from './client';
import { Meter, MeterReading, SyncStatus, TenantInfo, MeterSyncStatus } from '../types';
import axios from 'axios';

const CLIENT_API_URL = import.meta.env.VITE_CLIENT_API_URL || 'https://client.meterit.com/api';

export const metersApi = {
  getAll: async (): Promise<Meter[]> => {
    try {
      const response = await apiClient.get<Meter[]>('/api/local/meters');
      return response.data;
    } catch (error) {
      console.warn('⚠️ [Meters] Failed to fetch meters, returning empty array:', error);
      return [];
    }
  },
};

export const readingsApi = {
  getRecent: async (hours: number = 24): Promise<MeterReading[]> => {
    try {
      const response = await apiClient.get<MeterReading[]>('/api/local/readings', {
        params: { hours },
      });
      return response.data;
    } catch (error) {
      console.warn('⚠️ [Readings] Failed to fetch readings, returning empty array:', error);
      return [];
    }
  },
};

export const localSyncApi = {
  getStatus: async (): Promise<SyncStatus> => {
    const response = await apiClient.get<SyncStatus>('/api/local/sync-status');
    return response.data;
  },

  triggerSync: async (): Promise<void> => {
    await apiClient.post('/api/local/sync-trigger');
  },
};

export const remoteMeterSyncApi = {
  getStatus: async (): Promise<MeterSyncStatus> => {
    try {
      // Use the meter-sync-status endpoint which provides detailed meter sync info
      const response = await apiClient.get<MeterSyncStatus>('/api/local/meter-sync-status');
      return response.data;
    } catch (error) {
      console.error('❌ [Meter Sync] Failed to fetch meter sync status:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          error.response?.data?.error ||
          error.message ||
          'Failed to fetch meter sync status'
        );
      }
      throw error;
    }
  },

  triggerSync: async (): Promise<{ success: boolean; message: string; result?: any }> => {
    try {
      // Use the meter-sync-trigger endpoint for triggering meter sync
      const response = await apiClient.post<{ success: boolean; message: string; result?: any }>(
        '/api/local/meter-sync-trigger'
      );
      return response.data;
    } catch (error) {
      console.error('❌ [Meter Sync] Failed to trigger meter sync:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          'Failed to trigger meter sync'
        );
      }
      throw error;
    }
  },
};

export const bacnetCollectionApi = {
  getStatus: async (): Promise<any> => {
    try {
      // Use the BACnet meter reading status endpoint
      const response = await apiClient.get<any>('/api/meter-reading/status');
      return response.data;
    } catch (error) {
      console.error('❌ [Meter Reading] Failed to fetch meter reading status:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          error.response?.data?.error ||
          error.message ||
          'Failed to fetch meter reading status'
        );
      }
      throw error;
    }
  },

  triggerCollection: async (): Promise<{ success: boolean; message: string; cycle_result?: any }> => {
    try {
      // Use the BACnet meter reading trigger endpoint
      const response = await apiClient.post<{ success: boolean; message: string; cycle_result?: any }>(
        '/api/meter-reading/trigger'
      );
      return response.data;
    } catch (error) {
      console.error('❌ [Meter Reading] Failed to trigger meter reading collection:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          error.response?.data?.error ||
          error.message ||
          'Failed to trigger meter reading collection'
        );
      }
      throw error;
    }
  },
};

export const uploadQueueApi = {
  getStatus: async (): Promise<any> => {
    try {
      const response = await apiClient.get<any>('/api/sync/meter-reading-upload/status');
      return response.data;
    } catch (error) {
      console.error('❌ [Meter Reading Upload] Failed to fetch upload status:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          error.response?.data?.error || 
          error.message || 
          'Failed to fetch upload status'
        );
      }
      throw error;
    }
  },

  getLog: async (): Promise<any[]> => {
    try {
      const response = await apiClient.get<any[]>('/api/sync/meter-reading-upload/log');
      return response.data;
    } catch (error) {
      console.error('❌ [Meter Reading Upload] Failed to fetch upload log:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          error.response?.data?.error || 
          error.message || 
          'Failed to fetch upload log'
        );
      }
      throw error;
    }
  },

  triggerUpload: async (): Promise<{ success: boolean; message: string; queue_size?: number }> => {
    try {
      const response = await apiClient.post<{ success: boolean; message: string; queue_size?: number }>(
        '/api/sync/meter-reading-upload/trigger'
      );
      return response.data;
    } catch (error) {
      console.error('❌ [Meter Reading Upload] Failed to trigger upload:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          error.response?.data?.error || 
          error.message || 
          'Failed to trigger upload'
        );
      }
      throw error;
    }
  },
};

export const meterDeviceApi = {
  getConnectivity: async (): Promise<Array<{ meter_id: number; name: string; ip: string; port: number; device_id: number; online: boolean }>> => {
    try {
      const response = await apiClient.get('/api/meters/connectivity');
      return response.data;
    } catch (error) {
      console.warn('⚠️ [Meter Device] Failed to fetch connectivity:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(error.response?.data?.error || error.message || 'Failed to fetch meter connectivity');
      }
      throw error;
    }
  },

  reinitialize: async (meterId: number): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await apiClient.post<{ success: boolean; error?: string }>(`/api/meters/${meterId}/reinitialize`);
      return response.data;
    } catch (error) {
      console.error('❌ [Meter Device] Failed to reinitialize meter:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(error.response?.data?.error || error.message || 'Failed to reinitialize meter');
      }
      throw error;
    }
  },
};

export const tenantApi = {
  getTenantInfo: async (): Promise<TenantInfo | null> => {
    try {
      const response = await apiClient.get<TenantInfo | null>('/api/local/tenant');
      return response.data;
    } catch (error) {
      // Log detailed error information for debugging
      if (axios.isAxiosError(error)) {
        console.error('❌ [Tenant] API Error:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
          code: error.code,
          endpoint: '/api/local/tenant',
          timestamp: new Date().toISOString(),
          baseURL: apiClient.defaults.baseURL,
        });
        
        // Return null for 404 (not found) instead of throwing
        if (error.response?.status === 404) {
          console.warn('⚠️ [Tenant] No tenant found (404) - returning null');
          return null;
        }
        
        // Return null for 503 (service initializing) instead of throwing
        if (error.response?.status === 503) {
          console.warn('⚠️ [Tenant] Service initializing (503) - returning null');
          return null;
        }
      } else {
        console.error('❌ [Tenant] Unexpected error:', error);
      }
      throw error;
    }
  },

  /**
   * Sync tenant data from remote to local database via MCP service
   */
  syncTenantFromRemote: async (tenantId: number): Promise<TenantInfo | null> => {
    try {
      const response = await apiClient.post<{
        success: boolean;
        message: string;
        sync_result: {
          inserted: number;
          updated: number;
          deleted: number;
          timestamp: Date;
        };
        tenant_data: TenantInfo | null;
      }>('/api/local/tenant-sync', { tenant_id: tenantId });

      if (!response.data.success) {
        throw new Error(response.data.message || 'Tenant sync failed');
      }

      return response.data.tenant_data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('❌ [Tenant] Failed to sync tenant from remote:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
          code: error.code,
          url: error.config?.url,
          baseURL: error.config?.baseURL,
          timestamp: new Date().toISOString(),
          responseData: error.response?.data,
        });
      } else {
        console.error('❌ [Tenant] Unexpected error:', error);
      }
      throw error;
    }
  },

  /**
   * Fetch tenant data from client API using the user's token
   */
  fetchTenantFromClientApi: async (token: string): Promise<TenantInfo | null> => {
    try {
      
      const clientApiClient = axios.create({
        baseURL: CLIENT_API_URL,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      const response = await clientApiClient.get<any>('/users/me');
      
      
      if (!response.data || !response.data.tenant) {
        console.warn('⚠️ [Tenant] No tenant data in response');
        console.warn('⚠️ [Tenant] Response data:', response.data);
        return null;
      }

      const tenantData: TenantInfo = {
        tenant_id: response.data.tenant.tenant_id,
        name: response.data.tenant.name,
        url: response.data.tenant.url,
        street: response.data.tenant.street,
        street2: response.data.tenant.street2,
        city: response.data.tenant.city,
        state: response.data.tenant.state,
        zip: response.data.tenant.zip,
        country: response.data.tenant.country,
        active: response.data.tenant.active,
      };

      return tenantData;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('❌ [Tenant] Failed to fetch tenant from client API:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
          code: error.code,
          url: error.config?.url,
          baseURL: error.config?.baseURL,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.error('❌ [Tenant] Unexpected error:', error);
      }
      throw error;
    }
  },

  /**
   * Sync tenant data to local database (DEPRECATED - use syncTenantFromRemote instead)
   */
  syncTenantToLocal: async (tenantData: TenantInfo): Promise<TenantInfo> => {
    try {

      // Call the local API to upsert tenant data
      const payload = {
        name: tenantData.name,
        tenant_id: tenantData.tenant_id,
        street: tenantData.street,
        street2: tenantData.street2,
        city: tenantData.city,
        state: tenantData.state,
        zip: tenantData.zip,
        country: tenantData.country,
        active: tenantData.active,
        api_key: tenantData.api_key,
      };

      const response = await apiClient.post<TenantInfo>('/api/local/tenant', payload);

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('❌ [Tenant] Failed to sync tenant to local database:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
          code: error.code,
          url: error.config?.url,
          baseURL: error.config?.baseURL,
          method: error.config?.method,
          timestamp: new Date().toISOString(),
          responseData: error.response?.data,
        });
      } else {
        console.error('❌ [Tenant] Unexpected error:', error);
      }
      throw error;
    }
  },

  /**
   * Delete tenant data from local database (logout)
   */
  logout: async (): Promise<void> => {
    try {
      await apiClient.delete('/api/local/tenant');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('❌ [Tenant] Failed to logout:', {
          status: error.response?.status,
          message: error.message,
        });
      } else {
        console.error('❌ [Tenant] Unexpected error during logout:', error);
      }
      throw error;
    }
  },
};
