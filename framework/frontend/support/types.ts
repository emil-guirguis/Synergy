/**
 * Shared support-ticket types. Backs `framework/backend/db/support_ticket.sql`
 * (same columns in every consuming app) and the generic
 * `@meterit/framework-backend/api/base/supportTicketSchema` form schema.
 */
export type TicketType = 'bug' | 'feature_request' | 'billing' | 'account' | 'technical' | 'general';
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface SupportTicket {
  id: string;
  support_ticket_id: number;
  tenant_id: number | null;
  client_tenant_id: number | null;
  users_id: number | string | null;
  assigned_to_users_id: number | string | null;
  title: string;
  description: string | null;
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  client_tenant_name?: string;
  created_by_name?: string;
  assigned_to_name?: string;
}

export interface CreateTicketPayload {
  title: string;
  description?: string;
  type?: TicketType;
  priority?: TicketPriority;
}

export interface UpdateTicketPayload {
  title: string;
  description?: string;
  type?: TicketType;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigned_to_users_id?: number | string | null;
  client_tenant_id?: number | null;
}

import type { EnhancedStore } from '../components/list/types';

/**
 * Both apps' entity-store hooks (createEntityHook) support bypassing the
 * read cache on refetch — needed right after creating a ticket, or the list
 * can keep showing stale data for up to the store's cache TTL.
 */
export interface SupportTicketsStore extends EnhancedStore<SupportTicket> {
  fetchItems: (opts?: { _bypassCache?: boolean }) => Promise<void>;
}

/** The per-app REST calls both page components need — each app's own store/service implements this against its own HTTP client + auth convention. */
export interface SupportTicketService {
  getAll(): Promise<{ items: SupportTicket[]; total: number }>;
  getById(id: number): Promise<SupportTicket>;
  create(payload: CreateTicketPayload): Promise<SupportTicket>;
  update(id: number, payload: UpdateTicketPayload): Promise<SupportTicket>;
}
