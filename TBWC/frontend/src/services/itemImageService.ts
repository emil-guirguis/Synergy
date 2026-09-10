/**
 * Client for PATCH /api/inventory/:id/image — the catalog-thumbnail review
 * verdict. Admin only, and the only write the otherwise read-only Inventory
 * module accepts (see TBWC/api/worker/routes/inventory.ts).
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import type { ImageStatus } from '../types/inventory';

export interface ItemImageState {
  qb_item_id: number;
  image_url: string | null;
  image_status: ImageStatus;
  image_source: string | null;
  image_confidence: number | null;
  image_source_url: string | null;
}

/**
 * Record a verdict on an item's thumbnail.
 *
 * `imageUrl` is for pasting a replacement by hand: passing a URL sets it and
 * marks the source 'manual'; passing '' clears it. Omitting it leaves the
 * stored picture alone, which is what approve/reject normally want.
 */
export async function setItemImageStatus(
  itemId: number | string,
  status: ImageStatus,
  imageUrl?: string
): Promise<ItemImageState> {
  const token = tokenStorage.getToken();
  const res = await fetch(`${API_BASE_URL}/inventory/${itemId}/image`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      image_status: status,
      ...(imageUrl === undefined ? {} : { image_url: imageUrl }),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}: ${res.statusText}`);
  }
  return (await res.json()).data;
}
