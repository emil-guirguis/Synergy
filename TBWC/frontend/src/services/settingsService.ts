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

// --- Scheduled Jobs tab: worker/cronMonitor.ts + worker/qbwc/staleAlert.ts's
// alert_setting (migration 102). ------------------------------------------

export interface CronRun {
  cron_run_log_id: number;
  job_name: string;
  status: 'running' | 'ok' | 'error';
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface CronLog {
  latest: CronRun[];
  recent: CronRun[];
  avg: { job_name: string; avg_ms: number; runs: number }[];
}

export interface AlertSetting {
  alert_setting_id: number;
  alert_key: string;
  enabled: boolean;
  notify_email: boolean;
  notify_inapp: boolean;
  threshold_minutes: number | null;
  throttle_hours: number;
  recipient_permission: string | null;
  recipient_user_ids: string[];
  updated_at: string;
}

export async function getCronLog(): Promise<CronLog> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings/cron-log`, { headers: authHeaders() }));
  return data.data;
}

export async function getAlertSettings(): Promise<AlertSetting[]> {
  const data = await parse(await fetch(`${API_BASE_URL}/settings/alerts`, { headers: authHeaders() }));
  return data.data;
}

export async function updateAlertSetting(alertKey: string, updates: Partial<AlertSetting>): Promise<AlertSetting> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/settings/alerts/${encodeURIComponent(alertKey)}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(updates),
    })
  );
  return data.data;
}
