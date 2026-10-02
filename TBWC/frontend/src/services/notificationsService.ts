/**
 * Header bell client — talks to the Worker's /api/notifications (thin wrapper
 * over @meterit/framework-backend/api/base/notifications).
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import type { NotificationListResult, NotificationsApi } from '@meterit/framework-frontend/components/notifications';

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

export const notificationsService: NotificationsApi = {
  async list(limit = 100, offset = 0): Promise<NotificationListResult> {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const data = await parse(await fetch(`${API_BASE_URL}/notifications?${q}`, { headers: authHeaders() }));
    return { notifications: data.data.notifications, total: data.data.total };
  },

  async count(): Promise<number> {
    const data = await parse(await fetch(`${API_BASE_URL}/notifications/count`, { headers: authHeaders() }));
    return data.data.count;
  },

  async acknowledge(notificationId: string): Promise<void> {
    await parse(await fetch(`${API_BASE_URL}/notifications/${notificationId}/acknowledge`, {
      method: 'POST',
      headers: authHeaders(),
    }));
  },

  async clear(notificationId: string): Promise<void> {
    await parse(await fetch(`${API_BASE_URL}/notifications/${notificationId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }));
  },

  async clearAll(): Promise<number> {
    const data = await parse(await fetch(`${API_BASE_URL}/notifications`, {
      method: 'DELETE',
      headers: authHeaders(),
    }));
    return data.data.deleted_count;
  },
};
