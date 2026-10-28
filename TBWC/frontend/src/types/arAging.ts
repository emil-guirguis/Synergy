/**
 * One AR Aging band: every open invoice between `minDays` and `maxDays` days
 * past its due date, inclusive, and the dollars still owed on them.
 * `maxDays: null` is the open-ended tail (over 90). The bands are disjoint and
 * start at 1, so they add up to `pastDue` exactly (see arAging.ts).
 */
export interface ArAgingBucket {
  minDays: number;
  maxDays: number | null;
  count: number;
  total: number;
}

/** A customer with at least one past-due invoice, for the report's filter. */
export interface ArAgingCustomer {
  list_id: string;
  name: string;
}

export interface ArAgingSummary {
  /** The customer the figures are narrowed to, or null for all of them. */
  customerListId: string | null;
  customers: ArAgingCustomer[];
  /** Everything 1+ day late — the sum of `buckets`. */
  pastDue: ArAgingBucket;
  buckets: ArAgingBucket[];
}

/**
 * One row of the AR Aging report's table — a past-due invoice plus the
 * collection detail kept on its AR tab and the customer's derived ADP.
 * `id` is what the invoice form fetches by when the row is clicked.
 */
export interface ArAgingInvoice {
  id: number;
  qb_invoice_id: number;
  customer_name: string | null;
  balance_remaining: string | number | null;
  ref_number: string | null;
  txn_date: string | null;
  due_date: string | null;
  notice_1_date: string | null;
  notice_2_date: string | null;
  notice_3_date: string | null;
  days_since_invoice: number | null;
  days_past_due: number | null;
  avg_days_to_pay: number | null;
  late_fee_applied: boolean;
  ar_notes: string | null;
}
