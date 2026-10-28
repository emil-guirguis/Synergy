// Users entity store — same pattern as MeterItPro (createEntityStore + REST service).
import type { User } from '../../types/auth';
import { createEntityStore, createEntityHook } from '../../store/slices/createEntitySlice';
import { withApiCall } from '../../store/middleware/apiMiddleware';
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';

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

const usersService = {
  async getAll(params?: any) {
    const q = new URLSearchParams();
    if (params?.page) q.append('page', String(params.page));
    if (params?.pageSize) q.append('limit', String(params.pageSize));
    if (params?.limit) q.append('limit', String(params.limit));
    if (params?.sortBy) q.append('sortBy', params.sortBy);
    if (params?.sortOrder) q.append('sortOrder', params.sortOrder);
    if (params?.search) q.append('search', params.search);
    if (params?.filters) {
      Object.entries(params.filters).forEach(([k, v]: [string, any]) => {
        if (v !== '' && v !== null && v !== undefined) q.append(k, String(v));
      });
    }
    const qs = q.toString();
    const data = await parse(await fetch(`${API_BASE_URL}/users${qs ? `?${qs}` : ''}`, { headers: authHeaders() }));
    return { items: data.data?.items || [], total: data.data?.total || 0, hasMore: false };
  },
  async getById(id: string) {
    const data = await parse(await fetch(`${API_BASE_URL}/users/${id}`, { headers: authHeaders() }));
    return data.data;
  },
  async create(data: Partial<User>) {
    const r = await parse(await fetch(`${API_BASE_URL}/users`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(data) }));
    return r.data;
  },
  async update(id: string, data: Partial<User>) {
    const r = await parse(await fetch(`${API_BASE_URL}/users/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(data) }));
    return r.data;
  },
  async delete(id: string) {
    await parse(await fetch(`${API_BASE_URL}/users/${id}`, { method: 'DELETE', headers: authHeaders() }));
  },
};

export const useUsersStore = createEntityStore<User & { id: string }>(usersService as any, {
  name: 'user',
  cache: { ttl: 5 * 60 * 1000, maxAge: 30 * 60 * 1000 },
});

export const useUsers = createEntityHook(useUsersStore);

export const useUsersEnhanced = () => {
  const users = useUsers();
  return {
    ...users,
    createUser: (data: Partial<User>) =>
      withApiCall(() => users.createItem(data), { loadingKey: 'createUser', showSuccessNotification: true, successMessage: 'User created' }),
    updateUser: (id: string, data: Partial<User>) =>
      withApiCall(() => users.updateItem(id, data), { loadingKey: 'updateUser', showSuccessNotification: true, successMessage: 'User updated' }),
    deleteUser: (id: string) =>
      withApiCall(() => users.deleteItem(id), { loadingKey: 'deleteUser', showSuccessNotification: true, successMessage: 'User deleted' }),
  };
};
