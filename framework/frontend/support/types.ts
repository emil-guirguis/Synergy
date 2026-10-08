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
  serial_number: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  client_tenant_name?: string;
  created_by_name?: string;
  assigned_to_name?: string;
  csat_rating?: number | null;
  csat_submitted_at?: string | null;
}

/** Support Tickets admin summary (GET .../support/analytics) — ticket volume, avg resolution time, CSAT. */
export interface SupportAnalytics {
  total: number;
  last_7_days: number;
  last_30_days: number;
  avg_resolution_hours: number | null;
  avg_csat: number | null;
  csat_count: number;
  by_status: Record<string, number>;
}

export interface CreateTicketPayload {
  title: string;
  description?: string;
  type?: TicketType;
  priority?: TicketPriority;
  status?: TicketStatus;
  serial_number?: string;
}

export interface UpdateTicketPayload {
  title: string;
  description?: string;
  type?: TicketType;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigned_to_users_id?: number | string | null;
  client_tenant_id?: number | null;
  serial_number?: string | null;
}

import type { EnhancedStore } from '../components/list/types';

/** Minimal shape TicketDetailPage needs to populate its "Assigned To" dropdown. */
export interface AssignableUser {
  id: string;
  name: string;
}

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
  /** Filer rates their own resolved/closed ticket 1-5. */
  submitCsat(id: number, rating: number): Promise<SupportTicket>;
  /** Admin-only summary powering the Support Tickets page's analytics tiles. Omit to hide them. */
  getAnalytics?(): Promise<SupportAnalytics>;
}
