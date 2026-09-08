/** Inventory catalog row (tbwc-site public.qb_item, QB-synced item list). PK is `qb_item_id`. */
export interface Inventory {
  qb_item_id: number;
  /** Normalised alias of qb_item_id set by the entity store (idFieldName). */
  id?: number | string;
  list_id: string;
  item_type: string | null;
  name: string | null;
  full_name: string | null;
  sales_desc: string | null;
  sales_price: number | null;
  is_active: boolean;
  category: string | null;
  upc_code: string | null;
  distribution_type: string | null;
  base_price: number | null;
  msrp: number | null;
  dnet_cost: number | null;
  moq: number | null;
  pack_qty: number | null;
  service_days: number | null;
  unit_weight: number | null;
}
