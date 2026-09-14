/**
 * Roles client for Settings > Roles (see TBWC/api/worker/routes/roles.ts).
 * The permission catalog comes from the server rather than being restated here:
 * a permission only means something if a route enforces it, so the API is the
 * only honest source for what can be granted.
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import type { ManagedRole, RoleGrant } from '@meterit/framework-frontend/components/settings';

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

export async function getRoles(): Promise<ManagedRole[]> {
  const json = await parse(await fetch(`${API_BASE_URL}/roles`, { headers: authHeaders() }));
  return json.data.items;
}

export async function getCatalog(): Promise<string[]> {
  const json = await parse(await fetch(`${API_BASE_URL}/roles/catalog`, { headers: authHeaders() }));
  return json.data.permissions;
}

export async function createRole(input: { code: string; name: string }): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/roles`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
  );
}

export async function renameRole(roleId: number, name: string): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/roles/${roleId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    })
  );
}

export async function saveGrants(roleId: number, grants: RoleGrant[]): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/roles/${roleId}/grants`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ grants }),
    })
  );
}

export async function deleteRole(roleId: number): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/roles/${roleId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
  );
}
