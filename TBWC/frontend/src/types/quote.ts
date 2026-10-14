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
  /** Always SUM(quote_line.amount) — recomputed server-side on every line change. */
  total: number | null;
  memo: string | null;
  sales_rep: string | null;
  sales_rep_list_id: string | null;
  /** TBWC-owned lifecycle flag (migration 059). */
  status: 'quote' | 'on_hold' | 'cancelled' | null;
}

/** public.quote_line row (quoteGridLineSchema.ts) — its own child resource at
 *  /quotes/:id/lines, edited per row in QuoteForm's ChildRowsGrid. */
export interface QuoteLine {
  quote_line_id: number;
  quote_id: number;
  qb_item_id: number | null;
  /** qb_item.full_name, set server-side on every item pick. */
  item_name: string | null;
  description: string | null;
  quantity: string | number;
  rate: string | number;
  /** quantity * rate, computed server-side. */
  amount: string | number;
  line_order: number;
}
