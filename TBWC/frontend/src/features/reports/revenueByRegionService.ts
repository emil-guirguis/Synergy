// Revenue by Region — a single aggregate endpoint, not a CRUD entity, so this
// is a plain fetch helper rather than an entity store (see revenueByRegion.ts
// on the API side for the region-parsing query).
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { RevenueByRegionSummary } from '../../types/revenueByRegion';

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

export const revenueByRegionService = {
  async getSummary(year?: number | 'all'): Promise<RevenueByRegionSummary> {
    const qs = year ? `?year=${year}` : '';
    const data = await parse(
      await fetch(`${API_BASE_URL}/reports/revenue-by-region/summary${qs}`, { headers: authHeaders() })
    );
    return data.data;
  },
};
