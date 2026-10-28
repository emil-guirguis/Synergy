// AR Aging — a single aggregate endpoint, not a CRUD entity, so this is a
// plain fetch helper rather than an entity store (see arAging.ts on the API
// side for the bucketing query).
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { ArAgingInvoice, ArAgingSummary } from '../../types/arAging';

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

export const arAgingService = {
  /** `customerListId` narrows every band to one customer; null is all of them. */
  async getSummary(customerListId?: string | null): Promise<ArAgingSummary> {
    const qs = customerListId ? `?customerListId=${encodeURIComponent(customerListId)}` : '';
    const data = await parse(
      await fetch(`${API_BASE_URL}/reports/ar-aging/summary${qs}`, { headers: authHeaders() })
    );
    return data.data;
  },

  /**
   * The rows behind the figures. `minDays`/`maxDays` are the clicked band's
   * own bounds (null for "every past-due invoice"); the customer filter
   * applies to both this and the summary, so the table always matches the
   * tiles above it.
   */
  async getInvoices(
    customerListId?: string | null,
    minDays?: number | null,
    maxDays?: number | null
  ): Promise<ArAgingInvoice[]> {
    const q = new URLSearchParams();
    if (customerListId) q.set('customerListId', customerListId);
    if (minDays !== null && minDays !== undefined) q.set('minDays', String(minDays));
    if (maxDays !== null && maxDays !== undefined) q.set('maxDays', String(maxDays));
    const qs = q.toString();
    const data = await parse(
      await fetch(`${API_BASE_URL}/reports/ar-aging/invoices${qs ? `?${qs}` : ''}`, { headers: authHeaders() })
    );
    return data.data?.items ?? [];
  },
};
