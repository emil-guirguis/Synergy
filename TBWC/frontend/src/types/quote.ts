/** Quote row shape (tbwc-site public.quote) — TBWC-owned, local-only (not
 *  synced with or pushed to QuickBooks — see migration 070). Every field is
 *  directly editable via quotesStore.ts / QuoteForm. */
export interface Quote {
  quote_id: number;
  /** Normalised alias of quote_id set by the entity store (idFieldName). */
  id?: number | string;
  ref_number: string | null;
  customer_list_id: string | null;
  customer_name: string | null;
  txn_date: string | null;
  total: number | null;
  /** Editable (quantity/rate/desc, plus add/remove) via the item picker — see QuoteForm. */
  lines: QuoteLine[] | null;
  memo: string | null;
  sales_rep: string | null;
  sales_rep_list_id: string | null;
  /** TBWC-owned lifecycle flag (migration 059). */
  status: 'quote' | 'on_hold' | 'cancelled' | null;
}

export interface QuoteLine {
  /** Display label for the picked item (QB FullName) — set alongside
   *  itemValue by the item picker (PickableLineItemsGrid). */
  item: string | null;
  /** The picked item's qb_item.qb_item_id. */
  itemValue?: number | null;
  desc: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
}
