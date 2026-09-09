/** Auth + user types for the TBWC portal (tbwc-site public.users). */

export type UserType = 'rep' | 'customer' | 'employee';

export interface User {
  id: string; // uuid, matches auth.users.id
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  agency_name: string | null;
  url: string | null;
  title: string | null;
  work_phone: string | null;
  ext: string | null;
  mobile: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
  about: string | null;
  approved: boolean;
  is_admin: boolean;
  type: UserType;
  can_approve_rep_leads: boolean;
  created_at: string;
  /** Convenience display name (first + last), populated client-side. */
  name?: string;
  /** This user's linked QB sales rep (public.qb_sales_rep), joined onto /auth/me. Null if not linked. */
  qb_sales_rep_id: number | null;
  /** The linked rep's ListID — what qb_sales_order.sales_rep_list_id stores. */
  sales_rep_list_id: string | null;
  sales_rep_initial: string | null;
  sales_rep_name: string | null;
}

/** Permission keys referenced by the list/form feature components. */
export enum Permission {
  USER_CREATE = 'user:create',
  USER_UPDATE = 'user:update',
  USER_DELETE = 'user:delete',
  ORDER_CREATE = 'order:create',
  ORDER_UPDATE = 'order:update',
  ORDER_DELETE = 'order:delete',
  INVENTORY_CREATE = 'inventory:create',
  INVENTORY_UPDATE = 'inventory:update',
  INVENTORY_DELETE = 'inventory:delete',
  QUOTE_CREATE = 'quote:create',
  QUOTE_UPDATE = 'quote:update',
  QUOTE_DELETE = 'quote:delete',
}

export interface LoginCredentials {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  expiresIn: number; // seconds
  user: User;
}
