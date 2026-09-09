// Invoice entity store — read-only. qb_invoice is synced from QuickBooks, so
// only getAll/getById hit the API; create/update/delete are never wired into the UI
// (the list disables those features) and throw defensively if ever called.
import { createEntityStore, createEntityHook } from '../../store/slices/createEntitySlice';
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { Invoice } from '../../types/invoice';

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

const READ_ONLY = 'Invoices are synced from QuickBooks and cannot be edited here.';

const invoiceService = {
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
    const data = await parse(await fetch(`${API_BASE_URL}/invoices${qs ? `?${qs}` : ''}`, { headers: authHeaders() }));
    return { items: data.data?.items || [], total: data.data?.total || 0, hasMore: false };
  },
  async getById(id: string) {
    const data = await parse(await fetch(`${API_BASE_URL}/invoices/${id}`, { headers: authHeaders() }));
    return data.data;
  },
  async create(): Promise<never> { throw new Error(READ_ONLY); },
  async update(): Promise<never> { throw new Error(READ_ONLY); },
  async delete(): Promise<never> { throw new Error(READ_ONLY); },
};

export const useInvoiceStore = createEntityStore<Invoice & { id: string }>(invoiceService as any, {
  name: 'invoice',
  cache: { ttl: 5 * 60 * 1000, maxAge: 30 * 60 * 1000 },
});

export const useInvoices = createEntityHook(useInvoiceStore);
