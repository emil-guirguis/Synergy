/**
 * Roles client for Settings > Roles (see MeterItPro/api/worker/routes/roles.ts).
 * The catalog comes from the server: a permission only means something if a
 * route enforces it, so restating the list here could only ever drift.
 */
import apiClient from './apiClient';
import type { ManagedRole, RoleGrant } from '@meterit/framework-frontend/components/settings';

export async function getRoles(): Promise<ManagedRole[]> {
  const { data } = await apiClient.get('/roles');
  return data.data.items;
}

export async function getCatalog(): Promise<string[]> {
  const { data } = await apiClient.get('/roles/catalog');
  return data.data.permissions;
}

export async function createRole(input: { code: string; name: string }): Promise<void> {
  await apiClient.post('/roles', input);
}

export async function renameRole(roleId: number, name: string): Promise<void> {
  await apiClient.put(`/roles/${roleId}`, { name });
}

export async function saveGrants(roleId: number, grants: RoleGrant[]): Promise<void> {
  await apiClient.put(`/roles/${roleId}/grants`, { grants });
}

export async function deleteRole(roleId: number): Promise<void> {
  await apiClient.delete(`/roles/${roleId}`);
}
