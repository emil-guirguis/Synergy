/** QuickBooks invoice row (tbwc-site public.qb_invoice). PK is `qb_invoice_id`.
 *  Read-only mirror synced from QuickBooks via the QBWC pull. */
export interface Invoice {
  qb_invoice_id: number;
  /** Normalised alias of qb_invoice_id set by the entity store (idFieldName). */
  id?: number | string;
  txn_id: string;
  edit_sequence: string | null;
  ref_number: string | null;
  customer_list_id: string | null;
  customer_name: string | null;
  sales_rep_list_id: string | null;
  /** Joined from public.qb_sales_rep by sales_rep_list_id — not a qb_invoice column. */
  sales_rep: string | null;
  /** Joined from public.qb_customer by customer_list_id — detail route only, so
   *  absent on a row that came from the list. Drives the AR tab's notice
   *  buttons (mailto: / tel:). */
  customer_email?: string | null;
  customer_phone?: string | null;
  txn_date: string | null;
  due_date: string | null;
  subtotal: number | null;
  total: number | null;
  balance_remaining: number | null;
  is_paid: boolean | null;
  lines: unknown[] | null;
  linked_txn: unknown[] | null;
  time_modified: string | null;
  synced_at: string | null;
}
