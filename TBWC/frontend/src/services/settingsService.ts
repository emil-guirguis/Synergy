/**
 * Company settings client — org info + system config shown on the Settings
 * page. Admin-only, singleton row (see TBWC/api/worker/routes/settings.ts).
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

export interface CompanySettings {
  name: string;
  address: {
    street: string;
    street2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  contactInfo: {
    url: string;
    email: string;
  };
  systemConfig: {
    timezone: string;
    dateFormat: string;
    timeFormat: string;
    currency: string;
    language: string;
    defaultPageSize: number;
  };
  updatedAt: string | null;
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

export async function getSettings(): Promise<CompanySettings> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings`, { headers: authHeaders() }));
  return data.data;
}

export async function updateSettings(updates: Partial<CompanySettings>): Promise<CompanySettings> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(updates),
    })
  );
  return data.data;
}
