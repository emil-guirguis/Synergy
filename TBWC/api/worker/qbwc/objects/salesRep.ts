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
import { pullSince } from '../incremental';
import { logDetail } from '../syncLog';

const REQUEST_ID = 'salesrep';

async function buildRequest(env: Env): Promise<string> {
  const fromMod = listModifiedFilter(await pullSince(env, 'SalesRep', 'qb_sales_rep', 'qbwc.salesrep.since'));
  const rq =
    `    <SalesRepQueryRq requestID="${REQUEST_ID}">\n` +
    // All (not ActiveOnly): combined with incremental FromModifiedDate,
    // ActiveOnly would exclude a rep the moment they go inactive (they no
    // longer match ActiveOnly), so that transition could never be re-fetched
    // and the stale is_active=true row would stick around forever. Same fix
    // as customer.ts — downstream consumers already filter on is_active.
    `      <ActiveStatus>All</ActiveStatus>${fromMod}\n` +
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

  // Must read before the upserts below: once they land, MAX(time_modified) on
  // qb_sales_rep reflects this response's own rows, so a same-call re-check
  // would no longer see the pre-pull state that made this a full pull.
  const wasFullPull = (await pullSince(env, 'SalesRep', 'qb_sales_rep', 'qbwc.salesrep.since')) === null;

  const rets = blocks(xml, 'SalesRepRet');
  console.log(`[QBWC] SalesRepQueryRs: ${rets.length} sales rep(s)`);
  const seenListIds: string[] = [];

  for (const ret of rets) {
    const listId = tag(ret, 'ListID');
    if (!listId) continue;
    seenListIds.push(listId);
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

  // Reconcile stale rows on an unfiltered pull (full reload, or first-ever run):
  // an ActiveStatus=All query with no FromModifiedDate is a complete answer of
  // every SalesRep list entry QB currently has, not iterated/paged (no
  // MaxReturned on this request), so anything already in our table but absent
  // here has been removed from QB's list entirely. QB's own ListDeletedQueryRq
  // (listDeleted.ts) only reports deletions from the last ~90 days, so it can
  // miss older ones — this catches those on the next full reload instead of
  // leaving them permanently stuck showing as active.
  if (wasFullPull) {
    const stale = await execQuery(
      env,
      `UPDATE public.qb_sales_rep SET qb_deleted_at = CURRENT_TIMESTAMP
       WHERE qb_deleted_at IS NULL AND list_id <> ALL($1)
       RETURNING list_id, name`,
      [seenListIds],
      'qbwc.salesrep.reconcile'
    );
    if (stale.rows.length > 0) {
      await logDetail(
        env, 'SalesRep', 'pull',
        `Removed ${stale.rows.length} sales rep(s) no longer in QuickBooks (full reload reconcile)`,
        null, stale.rows.length
      );
      console.log(`[QBWC] SalesRep reconcile: ${stale.rows.length} row(s) marked deleted (not in full pull)`);
    }
  }
}

const salesRep: QbObject = { name: 'SalesRep', requestID: REQUEST_ID, buildRequest, parseResponse, incremental: true };
export default salesRep;
