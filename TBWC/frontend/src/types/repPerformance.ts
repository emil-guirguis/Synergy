/** One sales rep's row in the Rep Performance & Commission Tracker report. */
export interface RepPerformanceRow {
  list_id: string;
  name: string;
  /** Sum of qb_invoice.total issued to this rep's customers this year. */
  booked: number;
  invoiceCount: number;
  /** Sum of payments applied to this rep's invoices, dated by payment date. */
  collected: number;
  /** Sum of qb_sales_order.commission_total for orders whose linked invoice is paid. */
  commissionPaid: number;
  paidOrderCount: number;
  /** Sum of qb_sales_order.sold_for for orders booked this year. */
  revenue: number;
  /** revenue - sum(d_net_cost). */
  grossProfit: number;
  /** Avg days from invoice date to first payment applied, or null if no data. */
  avgCollectionDays: number | null;
}

export interface RepPerformanceSummary {
  year: number;
  years: number[];
  items: RepPerformanceRow[];
  invoiceStatusMayBeStale: boolean;
}
