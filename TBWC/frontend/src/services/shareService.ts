/**
 * Share feature — "notify a colleague about this record." Sends an in-app
 * notification (GET /api/notifications bell) carrying a deep link back to
 * the shared record. Recipient search goes through /api/people (not the
 * admin-only /api/users) so any signed-in user can find someone to share with.
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

export interface SharePerson {
  id: string;
  label: string;
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

export async function searchPeople(query: string): Promise<SharePerson[]> {
  const q = new URLSearchParams({ q: query, limit: '10' });
  const data = await parse(
    await fetch(`${API_BASE_URL}/people/search?${q.toString()}`, { headers: authHeaders() })
  );
  return data.data ?? [];
}

export async function shareRecord(params: {
  recipientUserId: string;
  title: string;
  linkUrl: string;
  note?: string;
}): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/notifications`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        notification_type: 'share',
        severity: 'info',
        title: params.title,
        description: params.note || undefined,
        users_id: params.recipientUserId,
        link_url: params.linkUrl,
      }),
    })
  );
}
