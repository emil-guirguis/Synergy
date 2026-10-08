// Orders entity store — same pattern as Users (createEntityStore + REST service).
import { createEntityStore, createEntityHook } from '../../store/slices/createEntitySlice';
import { withApiCall } from '../../store/middleware/apiMiddleware';
import { tokenStorage } from '../../utils/tokenStorage';
import { API_BASE_URL } from '../../config/api';
import type { Order, LinkedInvoice, LinkedPayment, OrderImportIndexRow } from '../../types/order';

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

export const ordersService = {
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
    const data = await parse(await fetch(`${API_BASE_URL}/orders${qs ? `?${qs}` : ''}`, { headers: authHeaders() }));
    return { items: data.data?.items || [], total: data.data?.total || 0, hasMore: false };
  },
  async getById(id: string) {
    const data = await parse(await fetch(`${API_BASE_URL}/orders/${id}`, { headers: authHeaders() }));
    return data.data;
  },
  /** Invoices QB has linked to this order — both real invoices and the
   *  zero-total rows the order form shows as packing slips. */
  async getLinkedInvoices(id: string | number) {
    const data = await parse(await fetch(`${API_BASE_URL}/orders/${id}/invoices`, { headers: authHeaders() }));
    return (data.data?.items || []) as LinkedInvoice[];
  },
  /** Payments QB has applied against invoices linked to this order. */
  async getLinkedPayments(id: string | number) {
    const data = await parse(await fetch(`${API_BASE_URL}/orders/${id}/payments`, { headers: authHeaders() }));
    return (data.data?.items || []) as LinkedPayment[];
  },
  /** Exact (trimmed, case-insensitive) PO match — used by Settings > Document
   *  Import to resolve a folder name to the one order it belongs to. */
  async lookupByPo(po: string) {
    const data = await parse(
      await fetch(`${API_BASE_URL}/orders/lookup-po/${encodeURIComponent(po)}`, { headers: authHeaders() })
    );
    return (data.data || []) as Pick<Order, 'qb_sales_order_id' | 'ref_number' | 'customer_name' | 'po_number'>[];
  },
  /** Bulk match-key + TBWC-owned-field snapshot of every order — used by
   *  Settings > Commission Import to resolve sheet rows and diff in bulk
   *  instead of one lookup per row. */
  async importIndex() {
    const data = await parse(await fetch(`${API_BASE_URL}/orders/import-index`, { headers: authHeaders() }));
    return (data.data || []) as OrderImportIndexRow[];
  },
  // Creates a Hold for Release order — the only kind creatable here (a normal
  // order still only ever arrives via the QuickBooks sync; see routes/orders.ts).
  async create(data: Partial<Order>) {
    const r = await parse(await fetch(`${API_BASE_URL}/orders`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(data) }));
    return r.data;
  },
  async update(id: string, data: Partial<Order>) {
    const r = await parse(await fetch(`${API_BASE_URL}/orders/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(data) }));
    return r.data;
  },
  // Only ever succeeds for a Hold for Release row — a real synced order's 405
  // surfaces as a thrown error.
  async delete(id: string) {
    const r = await parse(await fetch(`${API_BASE_URL}/orders/${id}`, { method: 'DELETE', headers: authHeaders() }));
    return r.data;
  },
  /** Default recipient/sender/subject for the Email dialog — see
   *  routes/orders.ts's GET /:id/email. */
  async getEmailPreview(id: string | number) {
    const data = await parse(await fetch(`${API_BASE_URL}/orders/${id}/email`, { headers: authHeaders() }));
    return data.data as {
      customerEmail: string | null;
      refNumber: string | null;
      customerName: string | null;
      jobName: string | null;
      repEmail: string | null;
      repName: string | null;
    };
  },
  /** Builds a PDF of the order and emails it. recipientEmail omitted falls
   *  back to the customer's email on file (and 400s if there isn't one);
   *  subject/message omitted fall back to the standard template; replyTo
   *  omitted falls back to the order's assigned sales rep. */
  async sendEmail(id: string | number, params: { recipientEmail?: string; subject?: string; message?: string; replyTo?: string }) {
    const r = await parse(
      await fetch(`${API_BASE_URL}/orders/${id}/email`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(params),
      })
    );
    return r.data as { sent: boolean; recipient: string; refNumber: string | null };
  },
  /** The exact PDF the email will attach — see routes/orders.ts's GET /:id/email/pdf. */
  async getEmailPdf(id: string | number): Promise<Blob> {
    const res = await fetch(`${API_BASE_URL}/orders/${id}/email/pdf`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to load PDF preview (${res.status})`);
    return res.blob();
  },
  /** Open order value minus what's already invoiced against it — see
   *  routes/orders.ts's GET /reports/backlog. */
  async getBacklogReport() {
    const data = await parse(await fetch(`${API_BASE_URL}/orders/reports/backlog`, { headers: authHeaders() }));
    return data.data as { backlogTotal: number; orderCount: number };
  },
};

export const useOrdersStore = createEntityStore<Order & { id: string }>(ordersService as any, {
  name: 'order',
  cache: { ttl: 5 * 60 * 1000, maxAge: 30 * 60 * 1000 },
});

export const useOrders = createEntityHook(useOrdersStore);

export const useOrdersEnhanced = () => {
  const orders = useOrders();
  return {
    ...orders,
    createOrder: (data: Partial<Order>) =>
      withApiCall(() => orders.createItem(data), { loadingKey: 'createOrder', showSuccessNotification: true, successMessage: 'Order created' }),
    updateOrder: (id: string, data: Partial<Order>) =>
      withApiCall(() => orders.updateItem(id, data), { loadingKey: 'updateOrder', showSuccessNotification: true, successMessage: 'Order updated' }),
    deleteOrder: (id: string) =>
      withApiCall(() => orders.deleteItem(id), { loadingKey: 'deleteOrder', showSuccessNotification: true, successMessage: 'Order deleted' }),
  };
};
