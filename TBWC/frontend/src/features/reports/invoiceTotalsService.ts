// Invoice Totals report — a pair of aggregate endpoints, not a CRUD entity,
// so this is a plain fetch helper rather than an entity store (see
// invoiceTotals.ts on the API side for the query breakdown).
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { InvoiceTotalsGranularity, InvoiceTotalsSummary, InvoiceTotalsTrend } from '../../types/invoiceTotals';

export interface CustomRange {
  from: string; // ISO yyyy-mm-dd
  to: string;
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

function buildParams(period: InvoiceTotalsGranularity, repId?: string | null, customRange?: CustomRange): URLSearchParams {
  const q = new URLSearchParams({ period });
  if (repId) q.append('repId', repId);
  if (period === 'custom' && customRange) {
    q.append('from', customRange.from);
    q.append('to', customRange.to);
  }
  return q;
}

export const invoiceTotalsService = {
  async getSummary(
    period: InvoiceTotalsGranularity,
    repId?: string | null,
    customRange?: CustomRange
  ): Promise<InvoiceTotalsSummary> {
    const q = buildParams(period, repId, customRange);
    const data = await parse(
      await fetch(`${API_BASE_URL}/reports/invoice-totals/summary?${q.toString()}`, { headers: authHeaders() })
    );
    return data.data;
  },

  async getTrend(
    period: InvoiceTotalsGranularity,
    repId?: string | null,
    customRange?: CustomRange
  ): Promise<InvoiceTotalsTrend> {
    const q = buildParams(period, repId, customRange);
    const data = await parse(
      await fetch(`${API_BASE_URL}/reports/invoice-totals/timeseries?${q.toString()}`, { headers: authHeaders() })
    );
    return data.data;
  },
};
