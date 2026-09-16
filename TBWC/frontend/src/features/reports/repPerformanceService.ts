// Rep Performance & Commission Tracker — a single aggregate endpoint, not a
// CRUD entity, so this is a plain fetch helper rather than an entity store
// (see repPerformance.ts on the API side for the query breakdown).
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { RepPerformanceSummary } from '../../types/repPerformance';

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

export const repPerformanceService = {
  async getSummary(year?: number): Promise<RepPerformanceSummary> {
    const qs = year ? `?year=${year}` : '';
    const data = await parse(
      await fetch(`${API_BASE_URL}/reports/rep-performance/summary${qs}`, { headers: authHeaders() })
    );
    return data.data;
  },
};
