// Estimates entity store — same pattern as Orders (createEntityStore + REST service).
import { createEntityStore, createEntityHook } from '../../store/slices/createEntitySlice';
import { withApiCall } from '../../store/middleware/apiMiddleware';
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { Estimate } from '../../types/estimate';

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

export const estimatesService = {
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
    const data = await parse(await fetch(`${API_BASE_URL}/estimates${qs ? `?${qs}` : ''}`, { headers: authHeaders() }));
    return { items: data.data?.items || [], total: data.data?.total || 0, hasMore: false };
  },
  async getById(id: string) {
    const data = await parse(await fetch(`${API_BASE_URL}/estimates/${id}`, { headers: authHeaders() }));
    return data.data;
  },
  /** Promotes any staged draft edit (memo/lines) to actually push to QuickBooks
   *  next QBWC session — see routes/estimates.ts's POST /:id/push. */
  async push(id: string | number) {
    const data = await parse(await fetch(`${API_BASE_URL}/estimates/${id}/push`, { method: 'POST', headers: authHeaders() }));
    return data.data;
  },
  /** Creates a still-local draft (no txn_id until it's pushed to QuickBooks — see
   *  routes/estimates.ts's POST / and estimate.ts's EstimateAddRq). */
  async create(data: Partial<Estimate>) {
    const r = await parse(await fetch(`${API_BASE_URL}/estimates`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(data) }));
    return r.data;
  },
  async update(id: string, data: Partial<Estimate>) {
    const r = await parse(await fetch(`${API_BASE_URL}/estimates/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(data) }));
    return r.data;
  },
  /** Only ever succeeds for a still-local draft (txn_id IS NULL) — a synced
   *  estimate's 405 surfaces as a thrown error, same as orders/quotes never
   *  supporting delete at all. */
  async delete(id: string) {
    const r = await parse(await fetch(`${API_BASE_URL}/estimates/${id}`, { method: 'DELETE', headers: authHeaders() }));
    return r.data;
  },
};

export const useEstimatesStore = createEntityStore<Estimate & { id: string }>(estimatesService as any, {
  name: 'estimate',
  cache: { ttl: 5 * 60 * 1000, maxAge: 30 * 60 * 1000 },
});

export const useEstimates = createEntityHook(useEstimatesStore);

export const useEstimatesEnhanced = () => {
  const estimates = useEstimates();
  return {
    ...estimates,
    updateEstimate: (id: string, data: Partial<Estimate>) =>
      withApiCall(() => estimates.updateItem(id, data), { loadingKey: 'updateEstimate', showSuccessNotification: true, successMessage: 'Estimate saved' }),
    pushEstimate: (id: string | number) =>
      withApiCall(() => estimatesService.push(id), { loadingKey: 'pushEstimate', showSuccessNotification: true, successMessage: 'Pushed to QuickBooks' }),
  };
};
