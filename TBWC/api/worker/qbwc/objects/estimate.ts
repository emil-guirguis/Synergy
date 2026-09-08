/**
 * Estimate (quote) pull (QB -> qb_estimate). QB Premier/Enterprise only.
 * Incremental via FromModifiedDate.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, refField, lineItems,
  qbTimeToTs, qbDate, num, txnModifiedFilter,
} from '../qbxml';
import { sinceModified } from '../incremental';

const REQUEST_ID = 'estimate';

async function buildRequest(env: Env): Promise<string> {
  const filter = txnModifiedFilter(await sinceModified(env, 'qb_estimate', 'qbwc.estimate.since'));
  return qbxmlDoc(
    `    <EstimateQueryRq requestID="${REQUEST_ID}">${filter}\n` +
    `      <IncludeLineItems>true</IncludeLineItems>\n    </EstimateQueryRq>`
  );
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'EstimateQueryRs');
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] EstimateQueryRs status', status, '(QB Pro does not support Estimates)');
    return;
  }
  const rets = blocks(xml, 'EstimateRet');
  console.log(`[QBWC] EstimateQueryRs: ${rets.length} estimate(s)`);

  for (const ret of rets) {
    const txnId = tag(ret, 'TxnID');
    if (!txnId) continue;
    const cust = refField(ret, 'CustomerRef');
    await execQuery(
      env,
      `INSERT INTO public.qb_estimate
         (txn_id, edit_sequence, ref_number, customer_list_id, customer_name, txn_date,
          total, lines, time_modified, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (txn_id) DO UPDATE SET
         edit_sequence=EXCLUDED.edit_sequence, ref_number=EXCLUDED.ref_number,
         customer_list_id=EXCLUDED.customer_list_id, customer_name=EXCLUDED.customer_name,
         txn_date=EXCLUDED.txn_date, total=EXCLUDED.total, lines=EXCLUDED.lines,
         time_modified=EXCLUDED.time_modified, raw=EXCLUDED.raw, synced_at=CURRENT_TIMESTAMP`,
      [
        txnId,
        tag(ret, 'EditSequence') ?? null,
        tag(ret, 'RefNumber') ?? null,
        cust.listId ?? null,
        cust.fullName ?? null,
        qbDate(tag(ret, 'TxnDate')),
        num(tag(ret, 'TotalAmount')),
        JSON.stringify(lineItems(ret, 'EstimateLineRet')),
        qbTimeToTs(tag(ret, 'TimeModified')),
        JSON.stringify({ txnId, ret: ret.slice(0, 8000) }),
      ],
      'qbwc.estimate.upsert'
    );
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (object_type, qb_list_id, qb_edit_sequence, last_synced_at)
       VALUES ('Estimate', $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence=EXCLUDED.qb_edit_sequence, last_synced_at=CURRENT_TIMESTAMP`,
      [txnId, tag(ret, 'EditSequence') ?? null],
      'qbwc.estimate.map'
    );
  }
}

const estimate: QbObject = { name: 'Estimate', requestID: REQUEST_ID, buildRequest, parseResponse };
export default estimate;
