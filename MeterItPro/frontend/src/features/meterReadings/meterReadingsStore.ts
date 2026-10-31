/**
 * Meter Readings Store
 * 
 * Read-only store for meter readings data
 * Provides data fetching and filtering (no create/update/delete)
 */

import { create } from 'zustand';
import type { MeterReading } from './meterReadingConfig';
import { tokenStorage } from '../../utils/tokenStorage';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

interface MeterReadingsState {
  items: MeterReading[];
  loading: boolean;
  error: string | null;

  // Pagination
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  lastFetchParams: any;

  // Fetch operations
  fetchItems: (params?: any) => Promise<void>;
  goToPage: (page: number) => Promise<void>;
  setPageSize: (pageSize: number) => Promise<void>;
  fetchByMeterId: (meterId: string) => Promise<void>;

  // Utility
  clearError: () => void;
}

/**
 * Meter readings store hook
 * Read-only - no create/update/delete operations
 */
export const useMeterReadings = create<MeterReadingsState>((set) => {
  return {
  items: [],
  loading: false,
  error: null,
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  lastFetchParams: null,

  fetchItems: async (params?: any) => {
    set({ loading: true, error: null });
    try {
      const queryParams = new URLSearchParams();
      
      // Get tenantId from params or localStorage
      const tenantId = params?.tenantId || localStorage.getItem('tenantId');
      if (!tenantId) {
        throw new Error('TenantId is required but not available');
      }
      queryParams.append('tenantId', tenantId);
      
      if (params?.page) queryParams.append('page', params.page.toString());
      if (params?.pageSize) queryParams.append('pageSize', params.pageSize.toString());
      if (params?.limit) queryParams.append('limit', params.limit.toString());
      if (params?.sortBy) queryParams.append('sortBy', params.sortBy);
      if (params?.sortOrder) queryParams.append('sortOrder', params.sortOrder);
      if (params?.search) queryParams.append('search', params.search);
      
      // Add optional filtering parameters
      if (params?.meterId) queryParams.append('meterId', params.meterId);
      if (params?.meterElementId) queryParams.append('meterElementId', params.meterElementId);
      
      // Flatten filters into query parameters
      if (params?.filters) {
        Object.entries(params.filters).forEach(([key, value]: [string, any]) => {
          // Skip empty, null, or undefined values
          if (value !== '' && value !== null && value !== undefined) {
            queryParams.append(key, String(value));
          }
        });
      }
      
      const queryString = queryParams.toString();
      const endpoint = queryString ? `/meterreadings?${queryString}` : '/meterreadings';
      
      
      const token = tokenStorage.getToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'GET',
        headers
      });


      if (!response.ok) {
        throw new Error('Failed to fetch meter readings');
      }

      const result = await response.json();
      
      
      if (result.success && result.data) {
        // Extract items from the response
        // The API returns { items: [...], total, page, pageSize, totalPages, hasMore }
        const items = Array.isArray(result.data) ? result.data : (result.data.items || []);
        const pagination = Array.isArray(result.data) ? {} : result.data;

        set({
          items,
          loading: false,
          page: pagination.page || params?.page || 1,
          pageSize: pagination.pageSize || params?.pageSize || 20,
          total: pagination.total || items.length,
          totalPages: pagination.totalPages || 1,
          lastFetchParams: params,
        });
      } else {
        throw new Error(result.message || 'Failed to fetch meter readings');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch meter readings';
      console.error('[MeterReadingsStore] Error:', message);
      set({ error: message, loading: false });
    }
  },

  goToPage: async (page: number) => {
    const { lastFetchParams, fetchItems } = (useMeterReadings as any).getState();
    await fetchItems({ ...lastFetchParams, page });
  },

  setPageSize: async (pageSize: number) => {
    const { lastFetchParams, fetchItems } = (useMeterReadings as any).getState();
    await fetchItems({ ...lastFetchParams, pageSize, page: 1 });
  },

  fetchByMeterId: async (meterId: string) => {
    set({ loading: true, error: null });
    try {
      const token = tokenStorage.getToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const response = await fetch(`${API_BASE_URL}/meterreadings/meter/${meterId}`, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        throw new Error('Failed to fetch meter readings');
      }

      const result = await response.json();
      
      if (result.success && result.data) {
        // Extract items from the response
        const items = Array.isArray(result.data) ? result.data : (result.data.items || []);
        
        set({ 
          items: items,
          loading: false 
        });
      } else {
        throw new Error(result.message || 'Failed to fetch meter readings');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch meter readings';
      set({ error: message, loading: false });
      console.error('Fetch meter readings by meter ID error:', error);
    }
  },

  clearError: () => set({ error: null }),
  };
});

/**
 * Enhanced hook with additional computed properties
 */
export const useMeterReadingsEnhanced = () => {
  const store = useMeterReadings();
  
  return {
    ...store,
    // Computed properties
    totalReadings: store.items.length,
    goodQualityReadings: store.items.filter(r => r.quality === 'good'),
    estimatedReadings: store.items.filter(r => r.quality === 'estimated'),
  };
};
