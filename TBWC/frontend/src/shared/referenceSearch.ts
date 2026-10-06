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
  const res = await fetch(
    `${API_BASE_URL}${config.endpoint}?search=${encodeURIComponent(query)}&limit=10`,
    { headers }
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const items: any[] = data?.data?.items ?? [];
  const valueField = config.valueField ?? 'value';
  const labelField = config.labelField ?? 'label';
  return items
    .filter((item) => item[valueField] != null)
    .map((item) => ({ value: item[valueField], label: item[labelField] ?? String(item[valueField]) }));
}
