/**
 * Client for the Users form's "Manages" grid — /api/user-managers/:managerId
 * (TBWC/api/worker/routes/userManagers.ts, migration 061-user-manager.sql),
 * a child-row resource under userGridManager:read/create/delete, in the shape
 * framework's ChildRowsGrid expects.
 */
import type { ChildRowsApi } from '@meterit/framework-frontend/components/datagrid/';
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

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

export const managedUsersApi: ChildRowsApi = {
  async list(managerId) {
    const r = await parse(await fetch(`${API_BASE_URL}/user-managers/${managerId}`, { headers: authHeaders() }));
    return r.data?.items ?? [];
  },
  async create(managerId, body) {
    const r = await parse(await fetch(`${API_BASE_URL}/user-managers/${managerId}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) }));
    return r.data;
  },
  async update() {
    // userGridManager has no write action — rows are added or removed, never edited.
    throw new Error('Managed-user rows cannot be edited — remove and re-add instead');
  },
  async remove(managerId, id) {
    const r = await parse(await fetch(`${API_BASE_URL}/user-managers/${managerId}/${id}`, { method: 'DELETE', headers: authHeaders() }));
    return r.data ?? {};
  },
};
