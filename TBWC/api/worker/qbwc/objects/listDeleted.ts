/**
 * List deletions (Customer, SalesRep, Item*). The transaction counterpart lives
 * in ./txnDeleted.ts; QB splits the two into separate queries — ListDeletedQueryRq
 * for list entities, TxnDeletedQueryRq for transactions — but the handling is the
 * same: a normal CustomerQueryRq/ItemQueryRq never mentions a deleted record, so
 * without this a customer/item/rep deleted in QB Desktop stayed in the portal.
 *
 * One qbXML doc, one ListDeletedQueryRq per type (a QBXMLMsgsRq may hold many
 * requests), so the whole sweep stays a single QBWC round trip. QB reports each
 * item sub-type separately (ItemInventory, ItemNonInventory, …) and they all
 * land in the one qb_item table, so the types are grouped by target table
 * before the UPDATE.
 *
 * Soft-delete (qb_deleted_at, migration 034) — never a real DELETE: qb_item is
 * the FK target of kit_items/quote_line and holds TBWC-owned columns
 * (image_url, notes, type), qb_sales_rep is the FK target of users.
 *
 * Merging two list entries in QB shows up here as a deletion of the losing one,
 * which is what we want — its ListID stops existing.
 *
 * Same ~90-day blind spot as txnDeleted.ts: QB's deleted-object log doesn't go
 * back further, so anything deleted before this sync existed needs a one-off
 * reconcile.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import { qbxmlDoc, tag, blocks } from '../qbxml';
import { logDetail, DETAIL_LOG_LIMIT } from '../syncLog';

const REQUEST_ID = 'listdeleted';

interface Target {
  /** Staging table holding the QB list record. */
  table: string;
  /** Column carrying a human-readable name for the sync log. */
  labelColumn: string;
  /** object_type written to qbwc_sync_run. */
  objectType: string;
  /** Word used in the log line ("Deleted item TB-1000"). */
  noun: string;
}

const CUSTOMER: Target = { table: 'public.qb_customer', labelColumn: 'full_name', objectType: 'Customer', noun: 'customer' };
const SALES_REP: Target = { table: 'public.qb_sales_rep', labelColumn: 'name', objectType: 'SalesRep', noun: 'sales rep' };
const ITEM: Target = { table: 'public.qb_item', labelColumn: 'full_name', objectType: 'Item', noun: 'item' };

/**
 * ListDelType -> where that deletion lands. Item sub-types mirror item.ts's
 * RET_TYPES: only the kinds we actually pull are asked for, so QB never reports
 * a deletion for a table we don't keep.
 */
const TARGETS: Record<string, Target> = {
  Customer: CUSTOMER,
  SalesRep: SALES_REP,
  ItemService: ITEM,
  ItemInventory: ITEM,
  ItemNonInventory: ITEM,
  ItemOtherCharge: ITEM,
  ItemInventoryAssembly: ITEM,
  ItemDiscount: ITEM,
};

async function buildRequest(_env: Env): Promise<string> {
  return qbxmlDoc(
    Object.keys(TARGETS)
      .map((t) =>
        `    <ListDeletedQueryRq requestID="${REQUEST_ID}:${t}">\n` +
        `      <ListDelType>${t}</ListDelType>\n    </ListDeletedQueryRq>`)
      .join('\n')
  );
}

/** Console-warn any Rs block QB refused; the rest of the payload still parses. */
function warnFailedBlocks(xml: string): void {
  for (const [, status] of xml.matchAll(/<ListDeletedQueryRs\b[^>]*\bstatusCode="([^"]*)"/g)) {
    // 0 = OK, 1 = no matching records (an empty sweep, not a failure).
    if (status !== '0' && status !== '1') console.error('[QBWC] ListDeletedQueryRs status', status);
  }
}

/** Mark one table's ListIDs deleted; returns how many rows were newly marked. */
async function markDeleted(env: Env, target: Target, listIds: string[]): Promise<number> {
  const r = await execQuery(
    env,
    `UPDATE ${target.table} SET qb_deleted_at = CURRENT_TIMESTAMP
     WHERE list_id = ANY($1) AND qb_deleted_at IS NULL
     RETURNING list_id, ${target.labelColumn} AS label`,
    [listIds],
    `qbwc.listdel.${target.objectType.toLowerCase()}.update`
  );
  const rows = r.rows;
  // One readable line per record up to the cap, then a single summary row — a
  // first run reads QB's whole 90-day deletion log and must not turn into
  // thousands of inserts inside one Worker request.
  if (rows.length <= DETAIL_LOG_LIMIT) {
    for (const row of rows) {
      await logDetail(env, target.objectType, 'pull', `Deleted ${target.noun} ${row.label ?? row.list_id}`);
    }
  } else if (rows.length > 0) {
    await logDetail(env, target.objectType, 'pull', `Deleted ${rows.length} ${target.noun}s in QuickBooks`, null, rows.length);
  }
  return rows.length;
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  // Per-type blocks come back mixed: onError is continueOnError, so a type this
  // QB build doesn't know fails on its own and the rest still carry Rets.
  warnFailedBlocks(xml);

  // Group by target table, not by ListDelType — the six item sub-types all
  // resolve to qb_item and take one UPDATE between them.
  const byTable = new Map<Target, string[]>();
  for (const ret of blocks(xml, 'ListDeletedRet')) {
    const delType = tag(ret, 'ListDelType');
    const listId = tag(ret, 'ListID');
    if (!delType || !listId) continue;
    const target = TARGETS[delType];
    if (!target) continue;
    const list = byTable.get(target) ?? [];
    list.push(listId);
    byTable.set(target, list);
  }
  if (byTable.size === 0) return;

  for (const [target, listIds] of byTable) {
    const marked = await markDeleted(env, target, listIds);
    console.log(`[QBWC] ListDeletedQueryRs: ${listIds.length} deleted ${target.objectType}(s) from QB, ${marked} newly marked`);
  }
}

const listDeleted: QbObject = {
  name: 'ListDeleted',
  requestID: REQUEST_ID,
  buildRequest,
  parseResponse,
};
export default listDeleted;
