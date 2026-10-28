// Invoice entity store. qb_invoice is synced from QuickBooks, so create/delete
// are never wired into the UI (the list disables them) and throw defensively if
// ever called. `update` is the one write: it carries the AR tab's TBWC-owned
// collection fields, and the API's WRITABLE allowlist drops anything else the
// form sends back (see routes/invoices.ts).
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

const READ_ONLY = 'Invoices are synced from QuickBooks and cannot be created or deleted here.';

export const invoiceService = {
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
  /** AR tab only — the API ignores every non-AR field in the payload. */
  async update(id: string, payload: any) {
    const data = await parse(
      await fetch(`${API_BASE_URL}/invoices/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      })
    );
    return data.data;
  },
  async delete(): Promise<never> { throw new Error(READ_ONLY); },
  /** Generic invoice PDF — see routes/invoices.ts's GET /:id/pdf. */
  async getPdf(id: string | number): Promise<Blob> {
    const res = await fetch(`${API_BASE_URL}/invoices/${id}/pdf`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to load invoice PDF (${res.status})`);
    return res.blob();
  },
  /**
   * Emails one collection notice for one invoice — the AR tab's per-section
   * Email-notice button. The Worker sends it (its own mail pipeline), locks
   * the notice's date/method, and attaches a copy to the invoice's
   * Documents tab; see routes/invoices.ts's sendInvoiceNoticeEmail.
   * `sentDate` is the sender's own local date (noticeActions.ts's
   * todayLocal()) — the Worker runs in UTC and has no business-day concept
   * of its own. `notice` is which section (1st/2nd/3rd) the sender actually
   * clicked; omitted, the Worker auto-picks the next never-sent slot.
   */
  async sendNoticeEmail(
    id: string | number,
    sentDate: string,
    notice?: number
  ): Promise<{ notice: number; recipient: string; refNumber: string | null; documented: boolean }> {
    const data = await parse(
      await fetch(`${API_BASE_URL}/invoices/${id}/notice-email`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sentDate, notice }),
      })
    );
    return data.data;
  },
  /** Same send, for however many invoices (1 or many) are selected on the
   *  AR Aging report — one result per invoice, so one bad row (no email on
   *  file) doesn't stop the rest from being notified. */
  async sendNoticeEmailBulk(
    ids: (string | number)[],
    sentDate: string
  ): Promise<{ id: string; success: boolean; message?: string; notice?: number; recipient?: string }[]> {
    const data = await parse(
      await fetch(`${API_BASE_URL}/invoices/notice-email/bulk`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ invoiceIds: ids.map(String), sentDate }),
      })
    );
    return data.data?.results ?? [];
  },
};

export const useInvoiceStore = createEntityStore<Invoice & { id: string }>(invoiceService as any, {
  name: 'invoice',
  cache: { ttl: 5 * 60 * 1000, maxAge: 30 * 60 * 1000 },
});

export const useInvoices = createEntityHook(useInvoiceStore);
