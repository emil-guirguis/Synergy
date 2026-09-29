import axios from 'axios';
import type { AxiosResponse } from 'axios';

// API base URL
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

export interface DashboardCard {
  dashboard_id: number;
  tenant_id: number;
  created_by_users_id: number;
  meter_id: number;
  meter_element_id: number;
  card_name: string;
  card_description?: string;
  selected_columns: string[];
  time_frame_type: 'today' | 'custom' | 'last_month' | 'this_month_to_date' | 'yearly' | 'since_installation';
  custom_start_date?: string;
  custom_end_date?: string;
  visualization_type: 'pie' | 'line' | 'candlestick' | 'bar' | 'area';
  grouping_type?: 'total' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  aggregation_type?: 'avg' | 'min' | 'max';
  grid_x?: number;
  grid_y?: number;
  grid_w?: number;
  grid_h?: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardCardResponse {
  items: DashboardCard[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AggregatedData {
  card_id: number;
  time_frame: {
    start: string;
    end: string;
  };
  aggregated_values: Record<string, number>;
  grouped_data?: Array<{
    date?: string;
    hour?: number;
    week_start?: string;
    month_start?: string;
    [key: string]: any;
  }>;
  grouping_type?: string;
  selected_columns?: string[];
  column_units?: Record<string, string>;
  meter_element_labels?: Record<number, string>;
  series_labels?: Record<string, string>;
  daily_values?: Array<{
    date: string;
    [key: string]: any;
  }>;
  meter_element?: {
    id: number;
    name: string;
  };
}

export interface MeterAnomaly {
  meter_reading_anomaly_id: number;
  meter_id: number;
  meter_element_id: number;
  metric: string;
  reading_at: string;
  // NUMERIC columns come back as strings from pg (avoids float precision loss) — cast with Number() before math/formatting.
  actual_value: string;
  expected_value: string;
  deviation: string;
  z_score: string | null;
  detected_at: string;
  meter_name: string;
  element_code: string | null;
  element_name: string | null;
}

export interface DetailedMeterReading {
  meter_reading_id: string;
  created_at: string;
  [key: string]: any; // Selected power columns
}

export interface DetailedReadingsResponse {
  items: DetailedMeterReading[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
  card_info?: {
    card_name: string;
    meter_element_name: string;
    time_frame: {
      start: string;
      end: string;
    };
  };
}

class DashboardService {
  private apiClient = axios.create({
    baseURL: API_BASE_URL,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  constructor() {
    // Add request interceptor to include auth token
    this.apiClient.interceptors.request.use(
      (config) => {
        const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );
  }

  // Get all dashboard cards for the authenticated user's tenant
  async getDashboardCards(params?: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<DashboardCardResponse> {
    try {
      const response: AxiosResponse<{ success: boolean; data: DashboardCardResponse }> = 
        await this.apiClient.get('/dashboard/cards', { params });
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to fetch dashboard cards';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Get a single dashboard card by ID
  async getDashboardCard(id: number): Promise<DashboardCard> {
    try {
      const response: AxiosResponse<{ success: boolean; data: DashboardCard }> = 
        await this.apiClient.get(`/dashboard/cards/${id}`);
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to fetch dashboard card';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Create a new dashboard card
  async createDashboardCard(data: Partial<DashboardCard>): Promise<DashboardCard> {
    try {
      const response: AxiosResponse<{ success: boolean; data: DashboardCard }> = 
        await this.apiClient.post('/dashboard/cards', data);
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to create dashboard card';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Update a dashboard card
  async updateDashboardCard(id: number, data: Partial<DashboardCard>): Promise<DashboardCard> {
    try {
      const response: AxiosResponse<{ success: boolean; data: DashboardCard }> = 
        await this.apiClient.put(`/dashboard/cards/${id}`, data);
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to update dashboard card';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Delete a dashboard card
  async deleteDashboardCard(id: number): Promise<void> {
    try {
      await this.apiClient.delete(`/dashboard/cards/${id}`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to delete dashboard card';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Get aggregated data for a dashboard card
  async getCardData(id: number, options?: { start_date?: string; end_date?: string }): Promise<AggregatedData> {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response: AxiosResponse<{ success: boolean; data: AggregatedData }> =
        await this.apiClient.get(`/dashboard/cards/${id}/data`, { params: { tz, ...options } });
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to fetch card data';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Get available power columns for a device
  async getPowerColumns(deviceId: number): Promise<Array<{ name: string; type: string; label: string }>> {
    try {
      const response: AxiosResponse<{ success: boolean; data: Array<{ name: string; type: string; label: string }> }> =
        await this.apiClient.get('/dashboard/power-columns', { params: { deviceId } });
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to fetch power columns';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Get detailed meter readings for a dashboard card (drill-down)
  async getDetailedReadings(
    cardId: number,
    params?: {
      page?: number;
      pageSize?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    }
  ): Promise<DetailedReadingsResponse> {
    try {
      const response: AxiosResponse<{ success: boolean; data: DetailedReadingsResponse }> = 
        await this.apiClient.get(`/dashboard/cards/${cardId}/readings`, { params });
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to fetch detailed readings';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Export detailed readings to CSV
  async exportReadingsToCSV(cardId: number): Promise<Blob> {
    try {
      const response = await this.apiClient.get(`/dashboard/cards/${cardId}/readings/export`, {
        responseType: 'blob',
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to export readings';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Get all meters for the authenticated user's tenant
  async getMetersByTenant(): Promise<Array<{ id: number; name: string }>> {
    try {
      const response: AxiosResponse<{ success: boolean; data: Array<{ id: number; name: string }> }> = 
        await this.apiClient.get('/dashboard/meters');
      return response.data.data;
    } catch (error) {
      console.error('Failed to fetch meters:', error);
      return [];
    }
  }

  // Get all meter elements for a specific meter
  async getMeterElementsByMeter(meterId: number): Promise<Array<{ meter_element_id: number; element: string; name: string; meter_id: number }>> {
    try {
      const response: AxiosResponse<{ success: boolean; data: Array<{ meter_element_id: number; element: string; name: string; meter_id: number }> }> =
        await this.apiClient.get(`/dashboard/meters/${meterId}/elements`);
      return response.data.data;
    } catch (error) {
      console.error(`Failed to fetch meter elements for meter ${meterId}:`, error);
      return [];
    }
  }

  // Get recent kW spikes flagged by the quality engine
  async getAnomalies(limit = 10): Promise<MeterAnomaly[]> {
    try {
      const response: AxiosResponse<{ success: boolean; data: MeterAnomaly[] }> =
        await this.apiClient.get('/dashboard/anomalies', { params: { limit } });
      return response.data.data;
    } catch (error) {
      console.error('Failed to fetch anomalies:', error);
      return [];
    }
  }

  // Get total active energy from all active meters
  /*
  async getTotalActiveEnergy(): Promise<number> {
    try {
      const response: AxiosResponse<{ success: boolean; data: { total_active_energy: number } }> =
        await this.apiClient.get('/dashboard/total-active-energy');
      return response.data.data?.total_active_energy ?? 0;
    } catch (error) {
      console.error('Failed to fetch total active energy:', error);
      return 0;
    }
  }

  // Get total power from all active meters
  async getTotalPower(): Promise<number> {
    try {
      const response: AxiosResponse<{ success: boolean; data: { total_power: number } }> =
        await this.apiClient.get('/dashboard/total-power');
      return response.data.data?.total_power ?? 0;
    } catch (error) {
      console.error('Failed to fetch total power:', error);
      return 0;
    }
  }
  */
}

// Export singleton instance
export const dashboardService = new DashboardService();
export { DashboardService };
export default dashboardService;
