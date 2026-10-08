import type { Inventory } from '../../types/inventory';

export const inventoryShareUrl = (item: Inventory) => `${window.location.origin}/inventory?openId=${item.qb_item_id}`;
export const inventoryShareTitle = (item: Inventory) => item.name ?? `Item ${item.qb_item_id}`;
