/**
 * Client for a kit's contents — GET/PUT /api/inventory/:id/kit-items
 * (TBWC/api/worker/routes/inventory.ts, migration 028).
 *
 * The save is replace-all, not per-row: the grid owns the whole ordered list,
 * and one drag can renumber every row and move one between groups. Reads are
 * open to any approved user; the save is admin only.
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import type { Inventory, KitItem } from '../types/inventory';

/** What the save sends per line — the server assigns kit_items_id and order_by. */
export interface KitItemInput {
  item_id: number;
  group_id: number | null;
  /** The group's label. The API stamps one group's first non-empty value on all its lines. */
  group_desc: string | null;
  /** How many of the item the kit needs. Omitted means 1 (the column default). */
  qty: number;
  /** false marks the line optional. Anything but an explicit false is required. */
  required: boolean;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function parse(res: Response) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export async function getKitItems(kitId: number | string): Promise<KitItem[]> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/inventory/${kitId}/kit-items`, { headers: authHeaders() })
  );
  return data.data?.items ?? [];
}

/**
 * Replace the kit's contents with `items`, in the order given — array position
 * within a group becomes order_by. Returns the saved rows (server ids and
 * numbering) so the caller can adopt them rather than guess.
 */
export async function saveKitItems(
  kitId: number | string,
  items: KitItemInput[]
): Promise<KitItem[]> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/inventory/${kitId}/kit-items`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ items }),
    })
  );
  return data.data?.items ?? [];
}

/**
 * Catalog lookup for the kit picker.
 *
 * Server-side search rather than pulling the catalog down once: it is 1200+
 * rows and growing, and the picker only ever shows a handful at a time. Lives
 * here, not in inventoryStore, because using the store's fetch would overwrite
 * the Inventory list's own paged results behind the user.
 */
export async function searchInventoryItems(term: string, limit = 25): Promise<Inventory[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (term.trim()) q.append('search', term.trim());
  const data = await parse(
    await fetch(`${API_BASE_URL}/inventory?${q.toString()}`, { headers: authHeaders() })
  );
  return data.data?.items ?? [];
}
