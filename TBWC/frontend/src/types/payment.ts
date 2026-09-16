/** QuickBooks ReceivePayment row (tbwc-site public.qb_payment). PK is
 *  `qb_payment_id`. Read-only mirror synced from QuickBooks via the QBWC pull —
 *  the AR side of the sync (see api/worker/qbwc/objects/payment.ts). */
export interface Payment {
  qb_payment_id: number;
  /** Normalised alias of qb_payment_id set by the entity store (idFieldName). */
  id?: number | string;
  txn_id: string;
  ref_number: string | null;
  customer_list_id: string | null;
  customer_name: string | null;
  txn_date: string | null;
  total_amount: number | null;
  /** [{txn_id, txn_type, ref_number, amount}] — which invoice(s) this was applied to. */
  applied_to: { txn_id: string; txn_type: string | null; ref_number: string | null; amount: number | null }[] | null;
  /** total_amount minus sum(applied_to[].amount) — unapplied customer credit. */
  unapplied_amount: number | null;
  time_modified: string | null;
  synced_at: string | null;
}
