/**
 * Transaction deletions (SalesOrder, Invoice). QB's normal *QueryRq never
 * returns a txn a QB Desktop user deleted — only TxnDeletedQueryRq does.
 * Without this, a deleted order/invoice just stayed in its staging table forever.
 *
 * One qbXML doc, one TxnDeletedQueryRq per type (a QBXMLMsgsRq may hold many
 * requests), so adding a type here costs no extra QBWC round trip. Each Rq
 * carries "<requestID>:<TxnDelType>" so dispatchResponse's prefix match still
 * routes the whole payload back here, and the parser reads TxnDelType off each
 * Ret rather than trusting request order.
 *
 * Soft-delete: sets qb_deleted_at rather than removing the row, so TBWC-owned
 * columns (build_notes, commission, etc.) survive. The route layer hides rows
 * where this is set.
 *
 * Not incremental — TxnDeletedQueryRq isn't iterated/date-filtered here; the
 * result set is just a list of TxnIDs, cheap to re-fetch in full every session,
 * and the UPDATE's `qb_deleted_at IS NULL` guard makes re-processing a no-op.
 *
 * Blind spot: QB only keeps deleted objects in this log for ~90 days. Anything
 * deleted before the first run of this sync is invisible to it and needs a
 * one-off reconcile (compare a full QB list against the table).
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import { qbxmlDoc, tag, blocks } from '../qbxml';
import { logDetail, DETAIL_LOG_LIMIT } from '../syncLog';
import { refreshOrderInvoiceStatus } from '../orderInvoiceStatus';

const REQUEST_ID = 'txndeleted';

interface Target {
  /** Staging table holding the QB txn. */
  table: string;
  /** Column carrying a human-readable id for the sync log. */
  labelColumn: string;
  /** object_type written to qbwc_sync_run. */
  objectType: string;
  /** Word used in the log line ("Deleted order TBWC 5687"). */
  noun: string;
}

/** TxnDelType -> where that deletion lands. Keys are the qbXML enum values. */
const TARGETS: Record<string, Target> = {
  SalesOrder: { table: 'public.qb_sales_order', labelColumn: 'ref_number', objectType: 'SalesOrder', noun: 'order' },
  Invoice: { table: 'public.qb_invoice', labelColumn: 'ref_number', objectType: 'Invoice', noun: 'invoice' },
};

async function buildRequest(_env: Env): Promise<string> {
  return qbxmlDoc(
    Object.keys(TARGETS)
      .map((t) =>
        `    <TxnDeletedQueryRq requestID="${REQUEST_ID}:${t}">\n` +
        `      <TxnDelType>${t}</TxnDelType>\n    </TxnDeletedQueryRq>`)
      .join('\n')
  );
}

/** Console-warn any Rs block QB refused; the rest of the payload still parses. */
function warnFailedBlocks(xml: string): void {
  for (const [, status] of xml.matchAll(/<TxnDeletedQueryRs\b[^>]*\bstatusCode="([^"]*)"/g)) {
    // 0 = OK, 1 = no matching records (an empty sweep, not a failure).
    if (status !== '0' && status !== '1') console.error('[QBWC] TxnDeletedQueryRs status', status);
  }
}

/** Mark one type's TxnIDs deleted; returns how many rows were newly marked. */
async function markDeleted(env: Env, delType: string, txnIds: string[]): Promise<number> {
  const target = TARGETS[delType];
  const r = await execQuery(
    env,
    `UPDATE ${target.table} SET qb_deleted_at = CURRENT_TIMESTAMP
     WHERE txn_id = ANY($1) AND qb_deleted_at IS NULL
     RETURNING txn_id, ${target.labelColumn} AS label`,
    [txnIds],
    `qbwc.txndel.${delType.toLowerCase()}.update`
  );
  const rows = r.rows;
  // One log line per record while the count is small enough to read; past that
  // a single summary row, so a first run against QB's 90-day deletion log can't
  // fire thousands of inserts inside one Worker request.
  if (rows.length <= DETAIL_LOG_LIMIT) {
    for (const row of rows) {
      await logDetail(env, target.objectType, 'pull', `Deleted ${target.noun} ${row.label ?? row.txn_id}`);
    }
  } else if (rows.length > 0) {
    await logDetail(env, target.objectType, 'pull', `Deleted ${rows.length} ${target.noun}s in QuickBooks`, null, rows.length);
  }
  return rows.length;
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  // One refused block (an unknown TxnDelType on an older QB, say) must not throw
  // away the types QB did answer — onError is continueOnError, so the payload
  // holds a mix, and Rets only exist under a block that succeeded.
  warnFailedBlocks(xml);

  // Group by TxnDelType so each staging table takes one UPDATE.
  const byType = new Map<string, string[]>();
  for (const ret of blocks(xml, 'TxnDeletedRet')) {
    const delType = tag(ret, 'TxnDelType');
    const txnId = tag(ret, 'TxnID');
    if (!delType || !txnId || !TARGETS[delType]) continue;
    const list = byType.get(delType) ?? [];
    list.push(txnId);
    byType.set(delType, list);
  }
  if (byType.size === 0) return;

  let invoicesMarked = 0;
  for (const [delType, txnIds] of byType) {
    const marked = await markDeleted(env, delType, txnIds);
    if (delType === 'Invoice') invoicesMarked += marked;
    console.log(`[QBWC] TxnDeletedQueryRs: ${txnIds.length} deleted ${delType}(s) from QB, ${marked} newly marked`);
  }
  // An order's invoice_number/invoice_status is denormalised off qb_invoice, so
  // a deleted invoice has to be recomputed out of the orders that quote it.
  if (invoicesMarked > 0) await refreshOrderInvoiceStatus(env);
}

const txnDeleted: QbObject = {
  name: 'TxnDeleted',
  requestID: REQUEST_ID,
  buildRequest,
  parseResponse,
};
export default txnDeleted;
