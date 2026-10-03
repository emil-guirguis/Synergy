import { createEntityStore, createEntityHook } from '../store/slices/createEntitySlice';
import { withTokenRefresh } from '../store/middleware/apiMiddleware';
import type { ListParams } from '../types/entities';
import type { SupportTicket, TicketType, CreateTicketPayload, UpdateTicketPayload } from '@meterit/framework-frontend/support';

export type { SupportTicket, TicketType, CreateTicketPayload, UpdateTicketPayload };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

class SupportTicketAPI {
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
      ...options,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as any;
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private normalize(t: any): SupportTicket {
    return { ...t, id: String(t.support_ticket_id) };
  }

  async getAll(_params?: ListParams): Promise<{ items: SupportTicket[]; total: number; hasMore: boolean }> {
    const res = await this.request<any>('/support/tickets');
    const items = (res.data?.items ?? []).map((t: any) => this.normalize(t));
    return { items, total: items.length, hasMore: false };
  }

  async getById(id: string): Promise<SupportTicket> {
    const res = await this.request<any>(`/support/tickets/${id}`);
    return this.normalize(res.data);
  }

  async create(data: Partial<SupportTicket>): Promise<SupportTicket> {
    const res = await this.request<any>('/support/tickets', { method: 'POST', body: JSON.stringify(data) });
    return this.normalize(res.data);
  }

  async update(id: string, data: Partial<SupportTicket>): Promise<SupportTicket> {
    const res = await this.request<any>(`/support/tickets/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    return this.normalize(res.data);
  }

  async delete(_id: string): Promise<void> {
    throw new Error('Ticket deletion is not permitted');
  }
}

const api = new SupportTicketAPI();

const supportTicketsService = {
  async getAll(params?: ListParams) { return withTokenRefresh(() => api.getAll(params)); },
  async getById(id: string)         { return withTokenRefresh(() => api.getById(id)); },
  async create(data: Partial<SupportTicket>) { return withTokenRefresh(() => api.create(data)); },
  async update(id: string, data: Partial<SupportTicket>) { return withTokenRefresh(() => api.update(id, data)); },
  async delete(_id: string): Promise<void> { throw new Error('Ticket deletion is not permitted'); },
};

export const useSupportTicketsStore = createEntityStore(supportTicketsService, {
  name: 'support_ticket',
  cache: { ttl: 2 * 60 * 1000, maxAge: 10 * 60 * 1000 },
});

export const useSupportTickets = createEntityHook(useSupportTicketsStore);
export const useSupportTicketsEnhanced = () => useSupportTickets();

// Legacy direct-call service (used by TicketDetailPage)
export const supportTicketService = {
  async getAll(): Promise<{ items: SupportTicket[]; total: number }> {
    return withTokenRefresh(async () => {
      const res = await api.getAll();
      return { items: res.items, total: res.total };
    });
  },
  async getById(id: number): Promise<SupportTicket> {
    return withTokenRefresh(() => api.getById(String(id)));
  },
  async create(payload: CreateTicketPayload): Promise<SupportTicket> {
    return withTokenRefresh(() => api.create(payload));
  },
  async update(id: number, payload: UpdateTicketPayload): Promise<SupportTicket> {
    return withTokenRefresh(() => api.update(String(id), payload));
  },
};
