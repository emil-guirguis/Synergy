/**
 * SalesOrder deletions. QB's normal SalesOrderQueryRq (see ./salesOrder.ts) never
 * returns a txn a QB Desktop user deleted — only TxnDeletedQueryRq does. Without
 * this, a deleted order just stayed in qb_sales_order forever.
 * Soft-delete: sets qb_deleted_at rather than removing the row, so TBWC-owned
 * columns (build_notes, commission, etc.) survive. routes/orders.ts hides rows
 * where this is set.
 * Not incremental — TxnDeletedQueryRq isn't iterated/date-filtered here; the
 * result set is just a list of TxnIDs, cheap to re-fetch in full every session,
 * and the UPDATE's `qb_deleted_at IS NULL` guard makes re-processing a no-op.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import { qbxmlDoc, tag, blocks, statusCode } from '../qbxml';
import { logDetail } from '../syncLog';

const REQUEST_ID = 'salesorderdeleted';

async function buildRequest(_env: Env): Promise<string> {
  return qbxmlDoc(
    `    <TxnDeletedQueryRq requestID="${REQUEST_ID}">\n` +
    `      <TxnDelType>SalesOrder</TxnDelType>\n    </TxnDeletedQueryRq>`
  );
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'TxnDeletedQueryRs');
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] TxnDeletedQueryRs status', status);
    return;
  }
  const rets = blocks(xml, 'TxnDeletedRet');
  const txnIds = rets
    .filter((ret) => tag(ret, 'TxnDelType') === 'SalesOrder')
    .map((ret) => tag(ret, 'TxnID'))
    .filter((id): id is string => !!id);
  if (txnIds.length === 0) return;

  const r = await execQuery(
    env,
    `UPDATE public.qb_sales_order SET qb_deleted_at = CURRENT_TIMESTAMP
     WHERE txn_id = ANY($1) AND qb_deleted_at IS NULL
     RETURNING txn_id, ref_number`,
    [txnIds],
    'qbwc.sodel.update'
  );
  for (const row of r.rows) {
    await logDetail(env, 'SalesOrder', 'pull', `Deleted order ${row.ref_number ?? row.txn_id}`);
  }
  console.log(`[QBWC] TxnDeletedQueryRs: ${txnIds.length} deleted SalesOrder(s) from QB, ${r.rowCount ?? 0} newly marked`);
}

const salesOrderDeleted: QbObject = {
  name: 'SalesOrderDeleted',
  requestID: REQUEST_ID,
  buildRequest,
  parseResponse,
};
export default salesOrderDeleted;
