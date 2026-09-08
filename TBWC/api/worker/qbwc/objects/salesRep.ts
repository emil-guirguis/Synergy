/**
 * SalesRep sync (PULL only).
 *
 * PULL (QB -> TBWC): SalesRepQueryRq, incremental via FromModifiedDate (the max
 * time_modified already stored). Each SalesRepRet is upserted into qb_sales_rep
 * and its ListID/EditSequence recorded in qbwc_map. No push — reps are authored
 * in QuickBooks; TBWC only links users to them (users.qb_sales_rep_id).
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, qbTimeToTs, refField, listModifiedFilter,
} from '../qbxml';
import { sinceModified } from '../incremental';

const REQUEST_ID = 'salesrep';

async function buildRequest(env: Env): Promise<string> {
  const fromMod = listModifiedFilter(await sinceModified(env, 'qb_sales_rep', 'qbwc.salesrep.since'));
  const rq =
    `    <SalesRepQueryRq requestID="${REQUEST_ID}">\n` +
    `      <ActiveStatus>ActiveOnly</ActiveStatus>${fromMod}\n` +
    `    </SalesRepQueryRq>`;
  return qbxmlDoc(rq);
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'SalesRepQueryRs');
  // statusCode 1 = "no matching records" (empty result) — not an error.
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] SalesRepQueryRs status', status);
    return;
  }

  const rets = blocks(xml, 'SalesRepRet');
  console.log(`[QBWC] SalesRepQueryRs: ${rets.length} sales rep(s)`);

  for (const ret of rets) {
    const listId = tag(ret, 'ListID');
    if (!listId) continue;
    const editSeq = tag(ret, 'EditSequence') ?? null;
    const timeModified = qbTimeToTs(tag(ret, 'TimeModified'));
    const entity = refField(ret, 'SalesRepEntityRef');
    const isActiveStr = tag(ret, 'IsActive');

    await execQuery(
      env,
      `INSERT INTO public.qb_sales_rep
         (list_id, edit_sequence, initial, name, entity_list_id, is_active,
          time_modified, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (list_id) DO UPDATE SET
         edit_sequence  = EXCLUDED.edit_sequence,
         initial        = EXCLUDED.initial,
         name           = EXCLUDED.name,
         entity_list_id = EXCLUDED.entity_list_id,
         is_active      = EXCLUDED.is_active,
         time_modified  = EXCLUDED.time_modified,
         raw            = EXCLUDED.raw,
         synced_at      = CURRENT_TIMESTAMP`,
      [
        listId,
        editSeq,
        tag(ret, 'Initial') ?? null,
        entity.fullName ?? null,
        entity.listId ?? null,
        isActiveStr == null ? null : isActiveStr === 'true',
        timeModified,
        JSON.stringify({ listId, ret: ret.slice(0, 8000) }),
      ],
      'qbwc.salesrep.upsert'
    );

    // Record the QB identity so future *ModRq can supply the current EditSequence.
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (object_type, qb_list_id, qb_edit_sequence, last_synced_at)
       VALUES ('SalesRep', $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence = EXCLUDED.qb_edit_sequence,
         last_synced_at   = CURRENT_TIMESTAMP`,
      [listId, editSeq],
      'qbwc.salesrep.map'
    );
  }
}

const salesRep: QbObject = { name: 'SalesRep', requestID: REQUEST_ID, buildRequest, parseResponse };
export default salesRep;
