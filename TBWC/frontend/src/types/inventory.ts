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
  /** TBWC classification (migration 028). 'kit' = a bundle whose contents are kit_items rows. */
  type: ItemType;
  /** TBWC-internal notes (migration 028). Not synced to QB, not printed. */
  notes: string | null;
  base_price: number | null;
  msrp: number | null;
  dnet_cost: number | null;
  moq: number | null;
  pack_qty: number | null;
  service_days: number | null;
  unit_weight: number | null;
  /** QuickBooks stock level (migration 029). NULL for types QB does not stock-track. */
  quantity_on_hand: number | string | null;
  /** Catalog thumbnail for the printed price sheet — see migration 027. */
  image_url: string | null;
  image_source_url: string | null;
  /** 'family' | 'search' | 'manual' — how the picture was chosen. */
  image_source: string | null;
  /** 0-100. Low means "a human should look at this". */
  image_confidence: number | null;
  image_status: ImageStatus;
  image_updated_at: string | null;
}

/**
 * 'pending' never attempted · 'auto' machine-picked, unreviewed · 'approved' /
 * 'rejected' human verdicts (the fetch script leaves these alone) · 'none' a
 * line item with no product photo to find (freight, labour, licences).
 */
export type ImageStatus = 'pending' | 'auto' | 'approved' | 'rejected' | 'none';

/** 'item' an ordinary catalog line · 'kit' a bundle, contents in public.kit_items. */
export type ItemType = 'item' | 'kit';

/**
 * One line of a kit (public.kit_items, PK kit_items_id). BOTH ids point at
 * qb_item: `qb_item_id` is the kit that owns the line, `item_id` the catalog
 * item the line names. The `item_*` fields are joined in by
 * GET /api/inventory/:id/kit-items and are not columns on the table.
 */
export interface KitItem {
  kit_items_id: number;
  /** The KIT this line belongs to. */
  qb_item_id: number;
  /** The catalog item this line names. */
  item_id: number;
  /** Grouping number the user assigns; rows sort by group, then order_by. */
  group_id: number | null;
  /** The group's label, denormalised onto every line of it (migration 031). */
  group_desc: string | null;
  /** Position within the group. Server-assigned from array order on save. */
  order_by: number;
  /** How many of the item this kit needs. TBWC's recipe, not a stock figure. */
  qty: number | string;
  /** false = an optional accessory a quote or pick list may leave out. Defaults true. */
  required: boolean;
  item_name: string | null;
  item_desc: string | null;
  item_price: number | string | null;
  item_image_url: string | null;
  /** The child item's QB stock level. NULL when QB does not stock-track it. */
  item_on_hand: number | string | null;
}
