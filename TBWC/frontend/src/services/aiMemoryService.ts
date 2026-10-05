/** Settings > AI Memory client (see TBWC/api/worker/routes/aiMemory.ts). Read-only. */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import type { AiMemoryFile } from '@meterit/framework-frontend/components/settings';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export async function getMemoryFiles(): Promise<AiMemoryFile[]> {
  const res = await fetch(`${API_BASE_URL}/ai/memory`, { headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  return json.data.files;
}
