// Invoice Totals report — a single aggregate endpoint, not a CRUD entity, so
// this is a plain fetch helper rather than an entity store (see
// invoiceTotals.ts on the API side for the query breakdown).
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { InvoiceTotalsSummary } from '../../types/invoiceTotals';

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

export const invoiceTotalsService = {
  async getSummary(year?: number, repId?: string | null): Promise<InvoiceTotalsSummary> {
    const q = new URLSearchParams();
    if (year) q.append('year', String(year));
    if (repId) q.append('repId', repId);
    const qs = q.toString();
    const data = await parse(
      await fetch(`${API_BASE_URL}/reports/invoice-totals/summary${qs ? `?${qs}` : ''}`, { headers: authHeaders() })
    );
    return data.data;
  },
};
