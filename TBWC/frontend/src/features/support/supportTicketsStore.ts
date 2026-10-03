// Support ticket entity store — same pattern as Orders (createEntityStore + REST service).
import { createEntityStore, createEntityHook } from '../../store/slices/createEntitySlice';
import { withTokenRefresh } from '../../store/middleware/apiMiddleware';
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { SupportTicket, CreateTicketPayload, UpdateTicketPayload } from '@meterit/framework-frontend/support';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: { ...authHeaders(), ...options.headers },
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as any;
    throw new Error(err.message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function normalize(t: any): SupportTicket {
  return { ...t, id: String(t.support_ticket_id) };
}

const api = {
  async getAll(): Promise<{ items: SupportTicket[]; total: number; hasMore: boolean }> {
    const res = await request<any>('/support');
    const items = (res.data?.items ?? []).map(normalize);
    return { items, total: res.data?.total ?? items.length, hasMore: false };
  },
  async getById(id: string): Promise<SupportTicket> {
    const res = await request<any>(`/support/${id}`);
    return normalize(res.data);
  },
  async create(data: CreateTicketPayload): Promise<SupportTicket> {
    const res = await request<any>('/support', { method: 'POST', body: JSON.stringify(data) });
    return normalize(res.data);
  },
  async update(id: string, data: UpdateTicketPayload): Promise<SupportTicket> {
    const res = await request<any>(`/support/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    return normalize(res.data);
  },
  async delete(): Promise<void> {
    throw new Error('Ticket deletion is not permitted');
  },
};

const supportTicketsService = {
  async getAll() { return withTokenRefresh(() => api.getAll()); },
  async getById(id: string) { return withTokenRefresh(() => api.getById(id)); },
  async create(data: CreateTicketPayload) { return withTokenRefresh(() => api.create(data)); },
  async update(id: string, data: UpdateTicketPayload) { return withTokenRefresh(() => api.update(id, data)); },
  async delete(): Promise<void> { throw new Error('Ticket deletion is not permitted'); },
};

export const useSupportTicketsStore = createEntityStore(supportTicketsService, {
  name: 'support_ticket',
  cache: { ttl: 2 * 60 * 1000, maxAge: 10 * 60 * 1000 },
});

export const useSupportTickets = createEntityHook(useSupportTicketsStore);
export const useSupportTicketsEnhanced = () => useSupportTickets();

// Direct-call service for TicketDetailPage, matching framework's SupportTicketService shape.
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
