/** Auth + user types for the TBWC portal (tbwc-site public.users). */

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
  /** What this user may do comes from here alone (resolved into `permissions`
   *  below). The old users.is_admin / users.type columns are gone — a boolean
   *  and a three-value enum could not express a custom role, and code that
   *  branched on them disagreed with the API's own grant checks. */
  role_id: number | null;
  /** Not a column — computed per request from the catalog-curator email list in
   *  the API's permissions.ts. True only for the account that owns inventory
   *  Type/Notes edits and catalog image review. */
  is_catalog_curator?: boolean;
  created_at: string;
  /** Convenience display name (first + last), populated client-side. */
  name?: string;
  /** This user's linked QB sales rep (public.qb_sales_rep), joined onto /auth/me. Null if not linked. */
  qb_sales_rep_id: number | null;
  /** The linked rep's ListID — what qb_sales_order.sales_rep_list_id stores. */
  sales_rep_list_id: string | null;
  sales_rep_initial: string | null;
  sales_rep_name: string | null;
  /** QB rep list_ids of every user this one manages (Users form's "Manages"
   *  tab / public.user_manager), joined onto /auth/me by loadProfile(). Empty
   *  array when this user manages no one. */
  managed_sales_rep_list_ids: string[];
  /** Settings > System Config default, overridable per-user via PUT /auth/me/preferences
   *  (null on this user row = inherits the org default) — joined/resolved onto /auth/me
   *  by loadProfile()'s COALESCE. */
  default_page_size: number | null;
  /** Same override-or-org-default resolution as default_page_size. */
  timezone: string | null;
  /** Same override-or-org-default resolution as default_page_size. Free-text pattern, e.g. "MM/DD/YYYY". */
  date_format: string | null;
  /** Same override-or-org-default resolution as default_page_size. */
  time_format: '12h' | '24h' | null;
  /** Org-only (no per-user override) — Settings > System Config's currency, ISO 4217 e.g. "USD". */
  currency: string | null;
  /** This caller's resolved role grants, joined onto /auth/me. Field names
   *  are camelCase here — this is PermissionSet.list()'s Grant shape
   *  (framework permissions.ts) serialized as-is, not the hidden_fields/
   *  field_access column names those come from. */
  permissions?: {
    permission: string;
    scope: 'all' | 'own';
    hiddenFields: string[];
    /** Per-field view/edit, keyed by field name or `column[].field` for a
     *  grid column (e.g. `lines[].rate`). */
    fieldAccess?: Record<string, { view?: boolean; edit?: boolean }>;
  }[];
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
