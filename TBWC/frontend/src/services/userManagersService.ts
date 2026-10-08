/**
 * Client for the flat "manages" relation — GET/POST/DELETE /api/user-managers
 * (TBWC/api/worker/routes/userManagers.ts, migration 061-user-manager.sql).
 *
 * Admin-only end to end, like the Users module itself — this is the only
 * place the relation gets configured, from the Users form's "Manages" tab.
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import type { User } from '../types/auth';

export interface ManagedUserRow {
  user_manager_id: number;
  manager_id: string;
  managed_user_id: string;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  /** QB sales rep short code (public.qb_sales_rep.initial), joined via qb_sales_rep_id. */
  sales_rep_initial: string | null;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function parse(res: Response) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export async function getManagedUsers(managerId: string): Promise<ManagedUserRow[]> {
  const q = new URLSearchParams({ manager_id: managerId });
  const data = await parse(
    await fetch(`${API_BASE_URL}/user-managers?${q.toString()}`, { headers: authHeaders() })
  );
  return data.data?.items ?? [];
}

export async function addManagedUser(managerId: string, managedUserId: string): Promise<ManagedUserRow> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/user-managers`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ manager_id: managerId, managed_user_id: managedUserId }),
    })
  );
  return data.data;
}

export async function removeManagedUser(userManagerId: number): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/user-managers/${userManagerId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
  );
}

/** Catalog lookup for the picker — reuses /api/users, like kitItemsService's searchInventoryItems. */
export async function searchUsers(term: string, limit = 25): Promise<User[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (term.trim()) q.append('search', term.trim());
  const data = await parse(
    await fetch(`${API_BASE_URL}/users?${q.toString()}`, { headers: authHeaders() })
  );
  return data.data?.items ?? [];
}
