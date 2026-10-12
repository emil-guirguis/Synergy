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
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  job_name: string | null;
  po_number: string | null;
  order_number: string | null;
  invoice_number: string | null;
  resolution_notes: string | null;
  serial_number: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  client_tenant_name?: string;
  created_by_name?: string;
  assigned_to_name?: string;
  /** Computed 'TK-NNNNNN' display id — not a real column, see supportTicketSchema.ts. */
  ticket_number?: string;
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
  contact_name: string;
  contact_phone: string;
  contact_email?: string;
  job_name?: string;
  po_number?: string;
  order_number?: string;
  invoice_number?: string;
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
  contact_name?: string;
  contact_phone?: string;
  contact_email?: string;
  job_name?: string;
  po_number?: string;
  order_number?: string;
  invoice_number?: string;
  resolution_notes?: string;
  serial_number?: string | null;
}

/** One hit from GET /support/invoices-by-serial/:serial. */
export interface InvoiceSerialMatch {
  qb_invoice_id: number;
  invoice_number: string | null;
  txn_date: string | null;
  description: string | null;
}

/** Result of GET /support/validate-po/:po. */
export interface PoValidationResult {
  valid: boolean;
  order_number?: string;
  customer_name?: string;
}

import type { EnhancedStore } from '../components/list/types';

/**
 * Both apps' entity-store hooks (createEntityHook) support bypassing the
 * read cache on refetch — needed right after creating a ticket, or the list
 * can keep showing stale data for up to the store's cache TTL.
 */
export interface SupportTicketsStore extends EnhancedStore<SupportTicket> {
  fetchItems: (opts?: { _bypassCache?: boolean }) => Promise<void>;
  /** Fetches one ticket fresh by id — used for the ?openId= deep link (see SupportTicketList.tsx) and BaseForm. */
  fetchItem: (id: string) => Promise<SupportTicket>;
  createItem: (data: Partial<SupportTicket>) => Promise<SupportTicket>;
  updateItem: (id: string, data: Partial<SupportTicket>) => Promise<SupportTicket>;
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
  /** Checks a typed PO number against the app's own orders table. Omit to hide PO validation (app has no orders concept). */
  validatePo?(po: string): Promise<PoValidationResult>;
  /** Finds invoices whose line items mention this serial number. Omit to hide the serial-number lookup panel. */
  findInvoicesBySerial?(serial: string): Promise<InvoiceSerialMatch[]>;
}
