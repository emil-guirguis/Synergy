/** Estimate row shape (tbwc-site public.qb_estimate) — QuickBooks' own
 *  "quote" object, PK `qb_estimate_id`. QB-synced fields are read-only in the
 *  UI; memo and lines are editable but only reach QuickBooks via the form's
 *  explicit "Push to QuickBooks" action (see estimatesStore.ts / EstimateForm). */
export interface Estimate {
  qb_estimate_id: number;
  /** Normalised alias of qb_estimate_id set by the entity store (idFieldName). */
  id?: number | string;
  /** Null for a still-local draft never sent to QuickBooks — see estimatesStore.ts's
   *  create() and estimate.ts's EstimateAddRq. Once set, customer/date are locked
   *  (createOnly in estimateSchema.ts) and further edits go through the push queue. */
  txn_id: string | null;
  ref_number: string | null;
  customer_list_id: string | null;
  customer_name: string | null;
  txn_date: string | null;
  total: number | null;
  /** EstimateLineRet rows, as captured by qbwc/qbxml.ts's lineItems(). Editable
   *  (quantity/rate/desc) for admins — see EstimateLinesGrid. */
  lines: EstimateLine[] | null;
  /** Editable — a save stages a 'draft' push (see qbwc_push_queue) and shows here
   *  immediately; only reaches QuickBooks once pushed. Same field throughout. */
  memo: string | null;
  sales_rep: string | null;
  sales_rep_list_id: string | null;
  time_modified: string | null;
  synced_at: string | null;
  /** TBWC-owned lifecycle flag (migration 059) — not from QuickBooks, never
   *  touched by the sync. Written directly regardless of push_state. */
  status: 'quote' | 'on_hold' | 'cancelled' | null;
  /** Where this record actually stands with QuickBooks — see routes/estimates.ts's
   *  PUSH_STATE_SELECT for the full definition:
   *    'draft'   — edited (or new) but never asked to push; button enabled.
   *    'pending' — push button pressed, queued for the next QBWC session,
   *                not yet confirmed landed; button disabled.
   *    'synced'  — txn_id set and nothing queued; matches QuickBooks. */
  push_state?: 'draft' | 'pending' | 'synced';
  /** Set once the "Push to QuickBooks" button has queued a still-local draft
   *  (txn_id null) to be created there — the next QBWC session sends the
   *  EstimateAddRq. Cleared once it lands (txn_id gets set). */
  pending_add?: boolean;
}

export interface EstimateLine {
  /** Display label for the picked item (QB FullName) — set alongside
   *  itemValue by the create-flow's item picker (PickableLineItemsGrid). */
  item: string | null;
  /** The picked item's QB ListID — what an EstimateAdd's ItemRef targets.
   *  Only ever set on a still-local draft's line (see estimate.ts's
   *  pendingAddRqs); a synced line never carries one. */
  itemValue?: string | null;
  desc: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
  /** QB's TxnLineID — required to target this line in a Mod push; a line
   *  without one (never synced) is dropped from what a Mod push sends. */
  txnLineId?: string | null;
}
