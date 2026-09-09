/** Order row shape (tbwc-site public.qb_sales_order). PK is `qb_sales_order_id`.
 * QB-synced fields are read-only in the UI; the TBWC-owned block at the bottom
 * (build_notes … trade_ally_fee) is what the order form edits. */
export interface Order {
  qb_sales_order_id: number;
  /** Normalised alias of qb_sales_order_id set by the entity store (idFieldName). */
  id?: number | string;
  txn_id: string;
  ref_number: string | null;
  customer_list_id: string | null;
  customer_name: string | null;
  txn_date: string | null;
  due_date: string | null;
  shipped_date: string | null;
  po_number: string | null;
  /** Editable — an admin's edit is queued for push to QB (see qbwc_push_queue)
   *  and shown here immediately; falls back to the last QB-synced value once
   *  nothing's pending. Same field throughout, no separate "pending" one. */
  memo: string | null;
  sales_rep: string | null;
  sales_rep_list_id: string | null;
  total: number | null;
  is_fully_invoiced: boolean | null;
  is_manually_closed: boolean | null;
  time_modified: string | null;
  synced_at: string | null;
  /** Denormalised from the linked qb_invoice (latest, via LinkedTxn). */
  invoice_number: string | null;
  invoice_status: string | null;
  bill_address_block: string | null;
  ship_address_block: string | null;
  freight_terms: string | null;
  ship_via: string | null;
  contact: string | null;
  customer_tax_code: string | null;
  /** SalesOrderLineRet rows, as captured by qbwc/qbxml.ts's lineItems(). */
  lines: OrderLine[] | null;
  // TBWC-owned (survive re-sync, editable in the order form)
  build_notes: string | null;
  job_name: string | null;
  expedite: boolean;
  jay: boolean;
  ship_no_later_than: string | null;
  d_net_cost: number | null;
  overage: number | null;
  project_admin_fee: number | null;
  commission_total: number | null;
  trade_ally_fee: number | null;
  rep_id: string | null;
}

export interface OrderLine {
  item: string | null;
  desc: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
}
