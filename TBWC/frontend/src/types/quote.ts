/** Quote line item (tbwc-site public.quote_line). */
export interface QuoteLine {
  quote_line_id?: number;
  quote_id?: number;
  qb_item_id: number | null;
  part_number: string | null;
  description: string | null;
  qty: number;
  unit_price: number;
  ext_price?: number;
  line_order?: number;
}

/** Quote header (tbwc-site public.quote). PK is `quote_id`. */
export interface Quote {
  quote_id: number;
  /** Normalised alias of quote_id set by the entity store (idFieldName). */
  id?: number | string;
  quote_number: string | null;
  project_name: string | null;
  customer: string | null;
  street_address: string | null;
  city_state_zip: string | null;
  poc: string | null;
  cc_email: string | null;
  status: string;
  rep: string | null;
  rep_id: string | null;
  notes: string | null;
  subtotal: number;
  tax: number;
  freight: number;
  total: number;
  /** Present on GET /:id and on create/update responses. */
  lines?: QuoteLine[];
}

/** Payload sent to create/update a quote (server recomputes ext/subtotal/total). */
export interface QuoteInput {
  quote_number?: string | null;
  project_name?: string | null;
  customer?: string | null;
  street_address?: string | null;
  city_state_zip?: string | null;
  poc?: string | null;
  cc_email?: string | null;
  status?: string;
  notes?: string | null;
  tax?: number;
  freight?: number;
  lines?: QuoteLine[];
}
