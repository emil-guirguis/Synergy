/**
 * Item pull (QB -> qb_item). ItemQueryRq returns each item as a type-specific
 * element (ItemServiceRet, ItemInventoryRet, …). Price/desc live either directly
 * (Inventory) or nested under SalesOrPurchase / SalesAndPurchase (Service etc.),
 * so we probe both. item_type is derived from the *Ret element name.
 *
 * Paged with a qbXML iterator + written as batched multi-row upserts: the first
 * enabled run returned a single 1.1MB ItemQueryRs and the old per-record
 * execQuery loop (2 queries/item, fresh connection each) blew the Worker's
 * limits — QBWC saw a 500 ("Internal server error") from receiveResponseXML.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import { qbxmlDoc, tag, blocks, statusCode, qbTimeToTs, num, listModifiedFilter, QB_MAX_RETURNED } from '../qbxml';
import { multiRowValues, chunk, BATCH_SIZE } from '../batchSql';
import { sinceModified } from '../incremental';

const REQUEST_ID = 'item';
// Exported so syncLog.ts can count rows for Item's response — QB never emits a
// bare <ItemRet>, only these type-specific variants.
export const RET_TYPES = [
  'ItemServiceRet', 'ItemInventoryRet', 'ItemNonInventoryRet',
  'ItemOtherChargeRet', 'ItemInventoryAssemblyRet', 'ItemDiscountRet',
];

async function buildRequest(env: Env): Promise<string> {
  // Incremental via FromModifiedDate, same pattern as Customer — ItemQueryRq's
  // filter applies uniformly across all item sub-types (Service, Inventory, …)
  // in one request, so one combined MAX(time_modified) works despite the
  // type-specific Ret elements. Still paged via iterator so no single response
  // carries the whole list.
  const filter = listModifiedFilter(await sinceModified(env, 'qb_item', 'qbwc.item.since'));
  return qbxmlDoc(
    `    <ItemQueryRq requestID="${REQUEST_ID}" iterator="Start">\n` +
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>${filter}\n` +
    `    </ItemQueryRq>`
  );
}

function priceDesc(ret: string): { price: number | null; desc: string | null } {
  // Direct (Inventory): <SalesPrice>, <SalesDesc>. Nested: SalesOrPurchase / SalesAndPurchase.
  const nested = blocks(ret, 'SalesOrPurchase')[0] || blocks(ret, 'SalesAndPurchase')[0] || '';
  const price = num(tag(ret, 'SalesPrice')) ?? num(tag(nested, 'SalesPrice')) ?? num(tag(nested, 'Price'));
  const desc = tag(ret, 'SalesDesc') ?? tag(nested, 'SalesDesc') ?? tag(nested, 'Desc') ?? null;
  return { price, desc };
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'ItemQueryRs');
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] ItemQueryRs status', status);
    return;
  }

  // Collect rows, deduped by list_id (last wins) — a duplicate key inside one
  // multi-row upsert makes Postgres error with "cannot affect row a second time".
  const byId = new Map<string, any[]>();
  for (const retName of RET_TYPES) {
    for (const ret of blocks(xml, retName)) {
      const listId = tag(ret, 'ListID');
      if (!listId) continue;
      const { price, desc } = priceDesc(ret);
      const isActive = tag(ret, 'IsActive');
      byId.set(listId, [
        listId,
        tag(ret, 'EditSequence') ?? null,
        retName.replace(/^Item/, '').replace(/Ret$/, ''),  // 'Service','Inventory',...
        tag(ret, 'Name') ?? null,
        tag(ret, 'FullName') ?? null,
        desc,
        price,
        isActive == null ? null : isActive === 'true',
        // Stock level. Only the stock-tracked types (Inventory,
        // InventoryAssembly) carry it; for the rest the tag is absent and NULL
        // is the honest answer — 0 would read as "out of stock". See
        // migration 029, which added the column and backfilled it from `raw`.
        num(tag(ret, 'QuantityOnHand')),
        qbTimeToTs(tag(ret, 'TimeModified')),
        JSON.stringify({ listId, ret: ret.slice(0, 8000) }),
      ]);
    }
  }
  console.log(`[QBWC] ItemQueryRs: ${byId.size} item(s)`);

  // Batched multi-row upserts: execQuery opens a connection per call, so a page
  // must be a handful of statements, not two per record.
  const CASTS = ['', '', '', '', '', '', '', '', '', '', '::jsonb'];
  for (const rows of chunk([...byId.values()], BATCH_SIZE)) {
    await execQuery(
      env,
      `INSERT INTO public.qb_item
         (list_id, edit_sequence, item_type, name, full_name, sales_desc, sales_price,
          is_active, quantity_on_hand, time_modified, raw, synced_at)
       VALUES ${multiRowValues(rows.length, CASTS, ', CURRENT_TIMESTAMP')}
       ON CONFLICT (list_id) DO UPDATE SET
         edit_sequence=EXCLUDED.edit_sequence, item_type=EXCLUDED.item_type, name=EXCLUDED.name,
         full_name=EXCLUDED.full_name, sales_desc=EXCLUDED.sales_desc, sales_price=EXCLUDED.sales_price,
         is_active=EXCLUDED.is_active, quantity_on_hand=EXCLUDED.quantity_on_hand,
         time_modified=EXCLUDED.time_modified, raw=EXCLUDED.raw,
         synced_at=CURRENT_TIMESTAMP`,
      rows.flat(),
      'qbwc.item.upsert'
    );

    // Record the QB identity so future *ModRq can supply the current EditSequence.
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (qb_list_id, qb_edit_sequence, object_type, last_synced_at)
       VALUES ${multiRowValues(rows.length, ['', ''], `, 'Item', CURRENT_TIMESTAMP`)}
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence=EXCLUDED.qb_edit_sequence, last_synced_at=CURRENT_TIMESTAMP`,
      rows.flatMap((r) => [r[0], r[1]]),
      'qbwc.item.map'
    );
  }
}

const item: QbObject = { name: 'Item', requestID: REQUEST_ID, buildRequest, parseResponse };
export default item;
