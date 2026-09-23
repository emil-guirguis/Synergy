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
  /** Denormalised from the linked invoice's FREIGHT line item (see
   *  orderInvoiceStatus.ts) — QB's sales order never carries freight itself.
   *  NULL when no real invoice is linked yet; 0 when one is but has no
   *  freight line. `total` above doesn't include it — add the two together
   *  for the order's actual grand total (see OrderLinesGrid). */
  freight: number | null;
  is_fully_invoiced: boolean | null;
  is_manually_closed: boolean | null;
  time_modified: string | null;
  synced_at: string | null;
  /** Denormalised from the linked qb_invoice (latest with total > 0, via
   *  LinkedTxn) — a zero-total invoice (packing slip) never lands here. */
  invoice_number: string | null;
  invoice_status: string | null;
  /** True when a zero-total invoice (packing slip) is linked, independent of
   *  invoice_number/invoice_status above (see orderInvoiceStatus.ts). */
  has_packing_slip: boolean | null;
  bill_address_block: string | null;
  ship_address_block: string | null;
  freight_terms: string | null;
  ship_via: string | null;
  /** Denormalised from the linked invoice's FREIGHT line Desc (see
   *  orderInvoiceStatus.ts) — free-typed shipping notes verbatim, not a
   *  parsed-out tracking number (the source data isn't structured enough). */
  shipping_tracking: string | null;
  contact: string | null;
  customer_tax_code: string | null;
  /** SalesOrderLineRet rows, as captured by qbwc/qbxml.ts's lineItems(). */
  lines: OrderLine[] | null;
  // TBWC-owned (survive re-sync, editable in the order form)
  build_notes: string | null;
  job_name: string | null;
  expedite: boolean;
  jay: boolean;
  /** Service work rather than a product build (migration 036) — admin-only. */
  service: boolean;
  ship_no_later_than: string | null;
  /** Manually entered actual ship date (migration 035) — distinct from
   *  shipped_date, which is QB's own synced <ShipDate>. */
  actual_ship_date: string | null;
  d_net_cost: number | null;
  overage: number | null;
  project_admin_fee: number | null;
  commission_total: number | null;
  trade_ally_fee: number | null;
  rep_id: string | null;
}

/** One invoice QB has linked to an order (GET /api/orders/:id/invoices).
 *  A zero-total row is a packing slip, which this company records in QB as a
 *  zero-total invoice — see OrderInvoicesPanel.tsx. */
export interface LinkedInvoice {
  qb_invoice_id: number;
  ref_number: string | null;
  txn_date: string | null;
  due_date: string | null;
  total: number | null;
  balance_remaining: number | null;
  is_paid: boolean | null;
  /** How this invoice was tied to the order: 'link' = QB's own LinkedTxn;
   *  'po' = inferred from customer + PO number; 'ambiguous' = that same
   *  customer+PO is on more than one order, so the match may be the wrong one. */
  matched_by?: 'link' | 'po' | 'ambiguous';
}

/** One (payment, invoice) application — a payment can be split across
 *  several invoices, so one qb_payment can produce several of these rows
 *  (GET /api/orders/:id/payments). qb_invoice_id ties the row to one of this
 *  order's LinkedInvoice rows; amount is the slice applied to that invoice
 *  specifically, not the payment's full total — see OrderInvoicesPanel.tsx. */
export interface LinkedPayment {
  qb_payment_id: number;
  qb_invoice_id: number;
  ref_number: string | null;
  txn_date: string | null;
  amount: number | null;
}

export interface OrderLine {
  item: string | null;
  desc: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
}
