/**
 * Contacts Store - Consolidated
 * 
 * Combines API service and state management for contacts.
 * Handles all contact-related data fetching, mutations, and state.
 */

import type { Contact } from './types';
import { createEntityStore, createEntityHook } from '../../store/slices/createEntitySlice';
import { withTokenRefresh } from '../../store/middleware/apiMiddleware';
import { tokenStorage } from '../../utils/tokenStorage';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

// ============================================================================
// API SERVICE (Internal)
// ============================================================================

interface ContactListParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filters?: Record<string, any>;
}

interface ContactListResponse {
  items: Contact[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

class ContactAPI {
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    // Get token from tokenStorage (which is synced by authService)
    const token = tokenStorage.getToken();
    
    
    if (!token) {
      console.error('[ContactAPI] No authentication token available');
      throw new Error('No authentication token available');
    }
    
    const config: RequestInit = {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
      ...options,
    };


    const response = await fetch(`${API_BASE_URL}${endpoint}`, config);
    
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[ContactAPI] Error response:', errorData);
      
      // Create a detailed error message
      const errorMessage = errorData.detail || errorData.error || errorData.message || `HTTP error! status: ${response.status}`;
      const error = new Error(errorMessage) as any;
      error.status = response.status;
      error.data = errorData;
      error.detail = errorData.detail;
      error.code = errorData.code;
      error.errorType = errorData.errorType;
      
      throw error;
    }

    return response.json();
  }

  async getAll(params: ContactListParams = {}): Promise<{ items: Contact[]; total: number; hasMore: boolean }> {
    const queryParams = new URLSearchParams();
    
    if (params.page) queryParams.append('page', params.page.toString());
    if (params.limit) queryParams.append('limit', params.limit.toString());
    if (params.sortBy) queryParams.append('sortBy', params.sortBy);
    if (params.sortOrder) queryParams.append('sortOrder', params.sortOrder);
    
    // Flatten filters into query parameters
    if (params.filters) {
      Object.entries(params.filters).forEach(([key, value]) => {
        // Skip empty, null, or undefined values
        if (value !== '' && value !== null && value !== undefined) {
          queryParams.append(key, String(value));
        }
      });
    }
    
    const queryString = queryParams.toString();
    
    const response = await this.request<{ data: ContactListResponse }>(`/contacts?${queryString}`);
    const data = response.data;
    
    return {
      items: data.items,
      total: data.total,
      hasMore: data.page < data.totalPages
    };
  }

  async getById(id: string): Promise<Contact> {
    const response = await this.request<{ data: Contact }>(`/contacts/${id}`);
    return response.data;
  }

  async create(data: Partial<Contact>): Promise<Contact> {
    const response = await this.request<{ data: Contact }>('/contacts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return response.data;
  }

  async update(id: string, data: Partial<Contact>): Promise<Contact> {
    const response = await this.request<{ data: Contact }>(`/contacts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return response.data;
  }

  async delete(id: string): Promise<void> {
    await this.request(`/contacts/${id}`, {
      method: 'DELETE',
    });
  }

}

const api = new ContactAPI();

// ============================================================================
// STORE CONFIGURATION
// ============================================================================

const contactsService = {
  async getAll(params?: any) {
    return withTokenRefresh(async () => {
      return api.getAll({
        page: params?.page,
        limit: params?.pageSize,
        sortBy: params?.sortBy,
        sortOrder: params?.sortOrder,
        filters: params?.filters,
      }) as any;
    });
  },

  async getById(id: string) {
    return withTokenRefresh(async () => api.getById(id));
  },

  async create(data: Partial<Contact>) {
    return withTokenRefresh(async () => api.create(data));
  },

  async update(id: string, data: Partial<Contact>) {
    return withTokenRefresh(async () => api.update(id, data));
  },

  async delete(_id: string) {
    return withTokenRefresh(async () => api.delete(_id));
  },
} as any;

export const useContactsStore = createEntityStore(contactsService, {
  name: 'contact',
  cache: {
    ttl: 10 * 60 * 1000, // 10 minutes
    maxAge: 60 * 60 * 1000, // 1 hour
  },
} as any);

export const useContacts = createEntityHook(useContactsStore);

// ============================================================================
// ENHANCED HOOK
// ============================================================================

export const useContactsEnhanced = () => {
  const contacts = useContacts();
  const items = Array.isArray(contacts.items) ? contacts.items : [];
  
  return {
    ...contacts,
    items,
    
    // Computed values
    activeContacts: items.filter((contact: any) => contact.active),
    inactiveContacts: items.filter((contact: any) => !contact.active),
  };
};
