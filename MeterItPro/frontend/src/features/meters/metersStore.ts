// Meters Entity Store

import { createEntityStore, createEntityHook } from '../../store/slices/createEntitySlice';
import { withApiCall, withTokenRefresh } from '../../store/middleware/apiMiddleware';
import { tokenStorage } from '../../utils/tokenStorage';

// Meter TypeScript type
export type Meter = {
  id?: string; // Alias for meter_id for compatibility
  meter_id: number;
  name: string;
  serial_number: string;
  device_id: number;
  location_id: number;
  ip: string;
  port: number;
  active: boolean;
  installation_date?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  status?: string;
  type?: string;
  lastReading?: {
    value: number;
    timestamp: string;
    quality?: 'good' | 'questionable' | 'estimated';
  };
  configuration?: {
    ipAddress?: string;
    port?: number;
  };
  [key: string]: any;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

// Real API service
const metersService = {
  async getAll(params?: any) {
    return withTokenRefresh(async () => {
      const queryParams = new URLSearchParams();

      if (params?.page) queryParams.append('page', params.page.toString());
      if (params?.limit) queryParams.append('limit', params.limit.toString());
      if (params?.sortBy) queryParams.append('sortBy', params.sortBy);
      if (params?.sortOrder) queryParams.append('sortOrder', params.sortOrder);
      if (params?.search) queryParams.append('search', params.search);

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
      const endpoint = queryString ? `/meters?${queryString}` : '/meters';
      
      const listHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const listToken = tokenStorage.getToken();
      if (listToken) listHeaders['Authorization'] = `Bearer ${listToken}`;

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'GET',
        headers: listHeaders
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Failed to fetch meters');
      }


      return {
        items: data.data.items || [],
        total: data.data.pagination?.total || data.data.pagination?.totalItems || 0,
        hasMore: data.data.pagination?.hasNextPage || false,
      };
    });
  },

  async getById(id: string) {
    return withTokenRefresh(async () => {
      const getHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const getToken = tokenStorage.getToken();
      if (getToken) getHeaders['Authorization'] = `Bearer ${getToken}`;

      const response = await fetch(`${API_BASE_URL}/meters/${id}`, {
        method: 'GET',
        headers: getHeaders
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Failed to fetch meter');
      }

      return data.data;
    });
  },

  async create(meterData: Partial<Meter>) {
    return withTokenRefresh(async () => {
      const createHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const createToken = tokenStorage.getToken();
      if (createToken) createHeaders['Authorization'] = `Bearer ${createToken}`;

      // Add timestamps if not provided
      const dataWithTimestamps = {
        ...meterData,
        created_at: meterData.created_at || new Date().toISOString(),
      };

      const response = await fetch(`${API_BASE_URL}/meters`, {
        method: 'POST',
        headers: createHeaders,
        body: JSON.stringify(dataWithTimestamps)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const detailedMsg = errorData.error ? `${errorData.message}: ${errorData.error}` : (errorData.message || `HTTP ${response.status}: ${response.statusText}`);
        console.error('[metersStore] Create error detail:', errorData);
        const error = new Error(detailedMsg) as any;
        error.response = {
          status: response.status,
          data: errorData
        };
        throw error;
      }

      const data = await response.json();

      if (!data.success) {
        const error = new Error(data.message || 'Failed to create meter') as any;
        error.response = {
          status: 400,
          data: data
        };
        throw error;
      }

      return data.data;
    });
  },

  async update(id: string, meterData: Partial<Meter>) {
    return withTokenRefresh(async () => {
      const updateHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const updateToken = tokenStorage.getToken();
      if (updateToken) updateHeaders['Authorization'] = `Bearer ${updateToken}`;

      const response = await fetch(`${API_BASE_URL}/meters/${id}`, {
        method: 'PUT',
        headers: updateHeaders,
        body: JSON.stringify(meterData)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`) as any;
        error.response = {
          status: response.status,
          data: errorData
        };
        throw error;
      }

      const data = await response.json();

      if (!data.success) {
        const error = new Error(data.message || 'Failed to update meter') as any;
        error.response = {
          status: 400,
          data: data
        };
        throw error;
      }

      return data.data;
    });
  },

  async delete(id: string) {
    return withTokenRefresh(async () => {
      const deleteHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const deleteToken = tokenStorage.getToken();
      if (deleteToken) deleteHeaders['Authorization'] = `Bearer ${deleteToken}`;

      const response = await fetch(`${API_BASE_URL}/meters/${id}`, {
        method: 'DELETE',
        headers: deleteHeaders
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Failed to delete meter');
      }

      return;
    });
  },

  // Test meter connection
  async testConnection(id: string) {
    return withTokenRefresh(async () => {
      const testHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const testToken = tokenStorage.getToken();
      if (testToken) testHeaders['Authorization'] = `Bearer ${testToken}`;

      const response = await fetch(`${API_BASE_URL}/meters/${id}/test-connection`, {
        method: 'POST',
        headers: testHeaders
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    });
  },
};

// Create meters store
export const useMetersStore = createEntityStore(metersService, {
  name: 'meter',
  cache: {
    ttl: 2 * 60 * 1000, // 2 minutes (meters data changes frequently)
    maxAge: 10 * 60 * 1000, // 10 minutes
  },
});

// Create meters hook
export const useMeters = createEntityHook(useMetersStore);

// Enhanced meters hook with additional functionality
export const useMetersEnhanced = () => {
  const meters = useMeters();

  return {
    ...meters,

    // Additional computed values
    activeMeters: meters.items.filter(meter => meter.status === 'active'),
    inactiveMeters: meters.items.filter(meter => meter.status === 'inactive'),
    maintenanceMeters: meters.items.filter(meter => meter.status === 'maintenance'),

    // Meters by type
    electricMeters: meters.items.filter(meter => meter.type === 'electric'),
    gasMeters: meters.items.filter(meter => meter.type === 'gas'),
    waterMeters: meters.items.filter(meter => meter.type === 'water'),

    // Reading quality analysis
    metersWithGoodReadings: meters.items.filter(meter =>
      meter.lastReading?.quality === 'good'
    ),
    metersWithQuestionableReadings: meters.items.filter(meter =>
      meter.lastReading?.quality === 'questionable'
    ),
    metersWithEstimatedReadings: meters.items.filter(meter =>
      meter.lastReading?.quality === 'estimated'
    ),

    // Communication status
    metersWithRecentReadings: meters.items.filter(meter => {
      if (!meter.lastReading?.timestamp) return false;
      const hoursSinceReading = (Date.now() - new Date(meter.lastReading.timestamp).getTime()) / (1000 * 60 * 60);
      return hoursSinceReading <= 24; // Within last 24 hours
    }),

    // Enhanced actions with notifications
    createMeter: async (data: Partial<Meter>) => {
      return withApiCall(
        () => meters.createItem(data),
        {
          loadingKey: 'createMeter',
          showSuccessNotification: true,
          successMessage: 'Meter created successfully',
        }
      );
    },

    updateMeter: async (id: string, data: Partial<Meter>) => {
      return withApiCall(
        () => meters.updateItem(id, data),
        {
          loadingKey: 'updateMeter',
          showSuccessNotification: true,
          successMessage: 'Meter updated successfully',
        }
      );
    },

    deleteMeter: async (id: string) => {
      return withApiCall(
        () => meters.deleteItem(id),
        {
          loadingKey: 'deleteMeter',
          showSuccessNotification: true,
          successMessage: 'Meter deleted successfully',
        }
      );
    },

    // Bulk operations
    bulkUpdateStatus: async (meterIds: string[], status: string) => {
      return withApiCall(
        async () => {
          const promises = meterIds.map(id => meters.updateItem(id, { status: status as Meter['status'] }));
          await Promise.all(promises);
        },
        {
          loadingKey: 'bulkUpdateMeters',
          showSuccessNotification: true,
          successMessage: `${meterIds.length} meters updated successfully`,
        }
      );
    },

    // Search and filter helpers
    searchMeters: (query: string) => {
      meters.setSearch(query);
      meters.fetchItems();
    },

    filterByType: (type: Meter['type']) => {
      meters.setFilters({ ...meters.list.filters, type });
      meters.fetchItems();
    },

    filterByStatus: (status: string) => {
      meters.setFilters({ ...meters.list.filters, status });
      meters.fetchItems();
    },

    filterByLocation: (locationId: string) => {
      meters.setFilters({ ...meters.list.filters, locationId });
      meters.fetchItems();
    },

    // Meter reading operations
    updateReading: async (id: string, reading: Meter['lastReading']) => {
      return meters.updateItem(id, { lastReading: reading });
    },

    // Configuration operations
    updateConfiguration: async (id: string, configuration: Partial<Meter['configuration']>) => {
      const meter = meters.items.find(m => m.id === id);
      if (!meter) throw new Error('Meter not found');

      const updatedConfig = { ...meter.configuration, ...configuration };
      return meters.updateItem(id, { configuration: updatedConfig });
    },

    // Specialized queries
    getMetersByLocation: (locationId: string) =>
      meters.items.filter(m => m.locationId === locationId),

    getMetersByType: (type: Meter['type']) =>
      meters.items.filter(m => m.type === type),

    // Analytics helpers
    getTotalConsumption: (type?: Meter['type']) => {
      const filteredMeters = type ? meters.items.filter(m => m.type === type) : meters.items;
      return filteredMeters.reduce((total, meter) => {
        return total + (meter.lastReading?.value || 0);
      }, 0);
    },

    getAverageConsumption: (type?: Meter['type']) => {
      const filteredMeters = type ? meters.items.filter(m => m.type === type) : meters.items;
      if (filteredMeters.length === 0) return 0;

      const total = filteredMeters.reduce((sum, meter) => {
        return sum + (meter.lastReading?.value || 0);
      }, 0);

      return total / filteredMeters.length;
    },
  };
};