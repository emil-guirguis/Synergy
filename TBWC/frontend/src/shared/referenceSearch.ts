// App-side implementation of the framework's generic `search` contract for
// ReferenceSearchField / PickableLineItemsGrid (@meterit/framework-frontend) —
// the framework knows nothing about TBWC's API base or auth, only that a
// schema field's `referenceSearch`/`lineItemPicker.itemSearch` config names a
// REST list endpoint to hit with `?search=`. Currently only quoteSchema.ts
// declares either option (customer_list_id, and lines' item picker).
import type { ReferenceSearchConfig, ReferenceSearchOption } from '@meterit/framework-frontend/components/form';
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

export async function tbwcReferenceSearch(
  config: ReferenceSearchConfig,
  query: string
): Promise<ReferenceSearchOption[]> {
  const headers: Record<string, string> = {};
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const searchFieldsParam = config.searchFields?.length
    ? `&searchFields=${encodeURIComponent(config.searchFields.join(','))}`
    : '';
  const res = await fetch(
    `${API_BASE_URL}${config.endpoint}?search=${encodeURIComponent(query)}&limit=10${searchFieldsParam}`,
    { headers }
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const items: any[] = data?.data?.items ?? [];
  const valueField = config.valueField ?? 'value';
  const labelFields = Array.isArray(config.labelField) ? config.labelField : [config.labelField ?? 'label'];
  const labelOf = (item: any) => labelFields.map((f) => item[f]).filter((v) => v != null && v !== '').join(' ');
  return items
    .filter((item) => item[valueField] != null)
    .map((item) => ({ value: item[valueField], label: labelOf(item) || String(item[valueField]), raw: item }));
}

// Voice-add's AI fallback (ChildRowsGrid's `voiceAdd.aiFallback`) — only called when the
// client's own naive "<qty> <item>" split and plain tbwcReferenceSearch already came back empty.
// Takes the RAW transcript, not a pre-split term: the split itself is ambiguous whenever the item
// name starts with a number (amperage/gauge/voltage), so the backend (routes/inventory.ts's
// voice-match route) re-derives both qty and the item from the whole utterance rather than
// trusting the client's first guess at either.
export async function aiMatchInventory(
  config: ReferenceSearchConfig,
  transcript: string
): Promise<{ qty: number; options: ReferenceSearchOption[] }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}${config.endpoint}/voice-match`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: transcript }),
  });
  if (!res.ok) return { qty: 1, options: [] };
  const data = await res.json().catch(() => null);
  const qty = typeof data?.data?.qty === 'number' && data.data.qty > 0 ? data.data.qty : 1;
  const items: any[] = data?.data?.items ?? [];
  const valueField = config.valueField ?? 'value';
  const labelFields = Array.isArray(config.labelField) ? config.labelField : [config.labelField ?? 'label'];
  const labelOf = (item: any) => labelFields.map((f) => item[f]).filter((v) => v != null && v !== '').join(' ');
  const options = items
    .filter((item) => item[valueField] != null)
    .map((item) => ({ value: item[valueField], label: labelOf(item) || String(item[valueField]), raw: item }));
  return { qty, options };
}
