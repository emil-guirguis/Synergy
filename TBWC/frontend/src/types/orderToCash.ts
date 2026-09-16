/** One row in the Uninvoiced Orders list (Order-to-Cash report). */
export interface UninvoicedOrder {
  id: number;
  refNumber: string | null;
  customerName: string | null;
  txnDate: string | null;
  total: number;
  invoiceStatus: string | null;
  salesRepName: string | null;
  daysOpen: number | null;
}

export interface OrderToCashSummary {
  year: number | 'all';
  years: number[];
  openOrders: { value: number; count: number };
  uninvoicedOrders: UninvoicedOrder[];
  avgDaysToPay: number | null;
  paidInvoiceCount: number;
  invoiceStatusMayBeStale: boolean;
}
