/**
 * QB Sync dashboard client — reads the Worker's admin-only /api/qb-sync views
 * over the qbwc_sync_run log and qb_* staging table counts.
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

export interface SyncRun {
  qbwc_sync_run_id: number;
  ticket: string | null;
  object_type: string;
  direction: 'pull' | 'push' | 'error';
  status_code: string | null;
  rows_processed: number;
  error: string | null;
  detail: string | null;
  created_at: string;
}

export interface SyncSummary {
  /** Latest run per object+direction. */
  latest: SyncRun[];
  /** Current row count per staging table, keyed by object type. */
  totals: Record<string, number>;
  /** ISO timestamp a full reload was queued for that object, or null/absent if
   *  none is pending. Cleared by the Worker once the re-pull fully drains. */
  reloads?: Record<string, string | null>;
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

export async function getSummary(): Promise<SyncSummary> {
  const data = await parse(await fetch(`${API_BASE_URL}/qb-sync/summary`, { headers: authHeaders() }));
  return data.data;
}

/**
 * Queue a full re-pull of one object type. Does not contact QuickBooks itself —
 * the Web Connector picks it up on its next update, then the flag clears once
 * the pull drains. Non-destructive: pulls upsert QB-owned columns only, so
 * TBWC-owned data (item images/notes, order build notes and money, attachments)
 * is untouched.
 */
export async function requestReload(objectType: string): Promise<void> {
  await parse(await fetch(`${API_BASE_URL}/qb-sync/reload`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ object_type: objectType }),
  }));
}

export interface SyncRunPage {
  items: SyncRun[];
  total: number;
}

export async function getRuns(objectType?: string, limit = 100, offset = 0): Promise<SyncRunPage> {
  const q = new URLSearchParams();
  if (objectType) q.append('object_type', objectType);
  q.append('limit', String(limit));
  q.append('offset', String(offset));
  const data = await parse(await fetch(`${API_BASE_URL}/qb-sync/runs?${q}`, { headers: authHeaders() }));
  return { items: data.data?.items || [], total: data.data?.total ?? 0 };
}
