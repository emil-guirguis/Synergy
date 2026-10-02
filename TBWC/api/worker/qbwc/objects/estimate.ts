/**
 * Estimate (QuickBooks' quote object) pull (QB -> qb_estimate) + push. QB
 * Premier/Enterprise only — QB Pro returns a statusCode we log and skip, same
 * as SalesOrder. Incremental via FromModifiedDate (pullSince, so the QB Sync
 * dashboard's per-object reload button works the same as every other object).
 *
 * Push covers two cases:
 *   - Editing a synced record (memo, or an existing line's quantity/rate/desc)
 *     — staged through the generic qbwc_push_queue outbox (see
 *     ../pushQueue.ts) as 'draft' by routes/estimates.ts's PUT, and only
 *     promoted to 'pending' (i.e. actually sent, as an EstimateModRq) by its
 *     POST /:id/push, the "Push to QuickBooks" button. A line push only ever
 *     touches an EXISTING line (matched by its captured TxnLineID) — adding
 *     or removing a line locally doesn't push; a line missing txnLineId (not
 *     yet QB-synced) is skipped.
 *   - Creating a brand-new estimate TBWC made manually (no txn_id at all —
 *     see migration 058) — flagged via qb_estimate.pending_add (set by the
 *     same POST /:id/push, since there's no txn_id yet for push_queue to key
 *     a 'draft' row by) and sent as an EstimateAddRq. Its requestID carries
 *     the LOCAL qb_estimate_id (not a txn_id, which doesn't exist yet) so a
 *     successful EstimateAddRs can be matched back to the right row and given
 *     its first real txn_id.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, refField, lineItems,
  qbTimeToTs, qbDate, num, txnModifiedFilter, QB_MAX_RETURNED, escapeXml,
} from '../qbxml';
import { pullSince } from '../incremental';
import { pendingPushes, markPushed, markFailed, type PendingPush } from '../pushQueue';
import { logDetail } from '../syncLog';

const REQUEST_ID = 'estimate';

// TBWC/schema field name (queued via routes/estimates.ts) -> QB XML tag.
// 'lines' isn't a single tag — its EstimateLineMod block is built separately
// in pendingModRqs below.
const FIELD_TO_QB_TAG: Record<string, string> = {
  memo: 'Memo',
};

interface DraftLine {
  txnLineId?: string | null;
  itemValue?: string | null;
  desc?: string | null;
  quantity?: number | null;
  rate?: number | null;
}

const ADD_REQUEST_PREFIX = `${REQUEST_ID}:add:`;

/** Group queued edits by txn_id, fetch each's current EditSequence, and build one EstimateModRq per record. */
async function pendingModRqs(env: Env): Promise<string[]> {
  const pending = await pendingPushes(env, 'Estimate');
  const byTxn = new Map<string, PendingPush[]>();
  for (const p of pending) {
    if (p.field_name !== 'lines' && !FIELD_TO_QB_TAG[p.field_name]) continue; // unrecognized — shouldn't happen, skip defensively
    const arr = byTxn.get(p.txn_id) ?? [];
    arr.push(p);
    byTxn.set(p.txn_id, arr);
  }
  if (byTxn.size === 0) return [];

  const r = await execQuery(
    env,
    `SELECT txn_id, edit_sequence FROM public.qb_estimate WHERE txn_id = ANY($1::text[])`,
    [[...byTxn.keys()]],
    'qbwc.estimate.editSequenceForPush'
  );
  const editSeqByTxn = new Map<string, string>(r.rows.map((row: any) => [row.txn_id, row.edit_sequence]));

  const rqs: string[] = [];
  for (const [txnId, fields] of byTxn) {
    const editSeq = editSeqByTxn.get(txnId);
    if (!editSeq) continue; // estimate not synced locally yet — retry once a pull has it

    const scalarTags = fields
      .filter((f) => f.field_name !== 'lines')
      .map((f) => `        <${FIELD_TO_QB_TAG[f.field_name]}>${escapeXml(f.new_value ?? '')}</${FIELD_TO_QB_TAG[f.field_name]}>`)
      .join('\n');

    const linesField = fields.find((f) => f.field_name === 'lines');
    let lineMods = '';
    if (linesField?.new_value) {
      let draftLines: DraftLine[] = [];
      try { draftLines = JSON.parse(linesField.new_value); } catch { draftLines = []; }
      lineMods = draftLines
        .filter((l) => l.txnLineId) // only existing lines — see header comment
        .map((l) => {
          const tags = [
            l.desc != null ? `          <Desc>${escapeXml(l.desc)}</Desc>` : '',
            l.quantity != null ? `          <Quantity>${l.quantity}</Quantity>` : '',
            l.rate != null ? `          <Rate>${l.rate}</Rate>` : '',
          ].filter(Boolean).join('\n');
          return (
            `        <EstimateLineMod>\n` +
            `          <TxnLineID>${escapeXml(l.txnLineId!)}</TxnLineID>\n` +
            `${tags}\n` +
            `        </EstimateLineMod>`
          );
        })
        .join('\n');
    }

    rqs.push(
      `    <EstimateModRq requestID="${REQUEST_ID}:mod:${txnId}">\n` +
      `      <EstimateMod>\n` +
      `        <TxnID>${escapeXml(txnId)}</TxnID>\n` +
      `        <EditSequence>${escapeXml(editSeq)}</EditSequence>\n` +
      `${scalarTags}${scalarTags && lineMods ? '\n' : ''}${lineMods}\n` +
      `      </EstimateMod>\n` +
      `    </EstimateModRq>`
    );
  }
  return rqs;
}

/** Build one EstimateAddRq per still-local draft (txn_id IS NULL) flagged pending_add. */
async function pendingAddRqs(env: Env): Promise<string[]> {
  const r = await execQuery(
    env,
    `SELECT qb_estimate_id, customer_list_id, txn_date, memo, lines, sales_rep_list_id
       FROM public.qb_estimate WHERE txn_id IS NULL AND pending_add = true`,
    [],
    'qbwc.estimate.pendingAdds'
  );
  return r.rows.map((row: any) => {
    let draftLines: DraftLine[] = [];
    try { draftLines = Array.isArray(row.lines) ? row.lines : JSON.parse(row.lines ?? '[]'); } catch { draftLines = []; }
    const lineAdds = draftLines
      .filter((l) => l.itemValue) // a line with no item picked can't be sent
      .map((l) => {
        const tags = [
          `          <ItemRef><ListID>${escapeXml(l.itemValue!)}</ListID></ItemRef>`,
          l.desc != null ? `          <Desc>${escapeXml(l.desc)}</Desc>` : '',
          l.quantity != null ? `          <Quantity>${l.quantity}</Quantity>` : '',
          l.rate != null ? `          <Rate>${l.rate}</Rate>` : '',
        ].filter(Boolean).join('\n');
        return `        <EstimateLineAdd>\n${tags}\n        </EstimateLineAdd>`;
      })
      .join('\n');
    const headerTags = [
      `        <CustomerRef><ListID>${escapeXml(row.customer_list_id)}</ListID></CustomerRef>`,
      row.sales_rep_list_id ? `        <SalesRepRef><ListID>${escapeXml(row.sales_rep_list_id)}</ListID></SalesRepRef>` : '',
      row.txn_date ? `        <TxnDate>${escapeXml(new Date(row.txn_date).toISOString().slice(0, 10))}</TxnDate>` : '',
      row.memo ? `        <Memo>${escapeXml(row.memo)}</Memo>` : '',
    ].filter(Boolean).join('\n');
    return (
      `    <EstimateAddRq requestID="${ADD_REQUEST_PREFIX}${row.qb_estimate_id}">\n` +
      `      <EstimateAdd>\n` +
      `${headerTags}\n${lineAdds}\n` +
      `      </EstimateAdd>\n` +
      `    </EstimateAddRq>`
    );
  });
}

async function buildRequest(env: Env): Promise<string> {
  const filter = txnModifiedFilter(await pullSince(env, 'Estimate', 'qb_estimate', 'qbwc.estimate.since'));
  const query =
    `    <EstimateQueryRq requestID="${REQUEST_ID}" iterator="Start">\n` +
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>${filter}\n` +
    `      <IncludeLineItems>true</IncludeLineItems>\n    </EstimateQueryRq>`;
  const mods = await pendingModRqs(env);
  const adds = await pendingAddRqs(env);
  return qbxmlDoc([query, ...mods, ...adds].join('\n'));
}

/** Build the qb_estimate upsert row from one EstimateRet (Query or Mod). */
function rowFromRet(ret: string): { txnId: string; row: any[] } | undefined {
  const txnId = tag(ret, 'TxnID');
  if (!txnId) return undefined;
  const cust = refField(ret, 'CustomerRef');
  const rep = refField(ret, 'SalesRepRef');
  return {
    txnId,
    row: [
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
      tag(ret, 'Memo') ?? null,
      rep.listId ?? null,
      rep.fullName ?? null,
    ],
  };
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'EstimateQueryRs');
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] EstimateQueryRs status', status, '(QB Pro does not support Estimates)');
    return;
  }

  const byId = new Map<string, any[]>();

  const queryBlock = xml.match(/<EstimateQueryRs\b[^>]*>([\s\S]*?)<\/EstimateQueryRs>/);
  const queryRets = queryBlock ? blocks(queryBlock[1], 'EstimateRet') : [];
  console.log(`[QBWC] EstimateQueryRs: ${queryRets.length} estimate(s)`);
  for (const ret of queryRets) {
    const parsed = rowFromRet(ret);
    if (parsed) byId.set(parsed.txnId, parsed.row);
  }

  // --- push (EstimateModRs) results, requestID "estimate:mod:<txnId>" (see
  //     pendingModRqs above). A successful Mod returns the full updated
  //     EstimateRet, folded into the same upsert; the pushed fields are
  //     cleared from qbwc_push_queue once it lands.
  const pending = await pendingPushes(env, 'Estimate');
  const queuedFieldsByTxn = new Map<string, string[]>();
  for (const p of pending) {
    const arr = queuedFieldsByTxn.get(p.txn_id) ?? [];
    arr.push(p.field_name);
    queuedFieldsByTxn.set(p.txn_id, arr);
  }

  const modRe = /<EstimateModRs\b([^>]*)>([\s\S]*?)<\/EstimateModRs>/g;
  let modMatch: RegExpExecArray | null;
  while ((modMatch = modRe.exec(xml)) !== null) {
    const attrs = modMatch[1];
    const inner = modMatch[2];
    const rid = attrs.match(/\brequestID="([^"]*)"/)?.[1];
    const txnId = rid?.startsWith(`${REQUEST_ID}:mod:`) ? rid.slice(`${REQUEST_ID}:mod:`.length) : undefined;
    if (!txnId) continue;
    const fieldNames = queuedFieldsByTxn.get(txnId) ?? [];
    const fieldLabel = fieldNames.join(', ') || 'field';
    const sc = attrs.match(/\bstatusCode="([^"]*)"/)?.[1];
    if (sc && sc !== '0') {
      const msg = attrs.match(/\bstatusMessage="([^"]*)"/)?.[1];
      console.error(`[QBWC] EstimateMod (push) failed for ${txnId}: ${sc} ${msg}`);
      if (fieldNames.length) await markFailed(env, 'Estimate', txnId, fieldNames, `${sc} ${msg ?? ''}`.trim());
      await logDetail(env, 'Estimate', 'push', `Failed to push ${fieldLabel} for estimate ${txnId}`, `${sc} ${msg ?? ''}`.trim());
      continue; // retried next session with the current edit_sequence
    }
    const ret = blocks(inner, 'EstimateRet')[0];
    const parsed = ret ? rowFromRet(ret) : undefined;
    if (parsed) byId.set(parsed.txnId, parsed.row);
    if (fieldNames.length) await markPushed(env, 'Estimate', txnId, fieldNames);
    const refLabel = ret ? (tag(ret, 'RefNumber') ?? txnId) : txnId;
    await logDetail(env, 'Estimate', 'push', `Pushed ${fieldLabel} to estimate ${refLabel}`);
  }

  // --- create (EstimateAddRs) results, requestID "estimate:add:<qb_estimate_id>"
  //     (see pendingAddRqs above). Handled separately from the byId upsert
  //     loop below — that loop is keyed by txn_id, which a still-local draft
  //     doesn't have yet, so its row can only be reached by qb_estimate_id.
  const addRe = /<EstimateAddRs\b([^>]*)>([\s\S]*?)<\/EstimateAddRs>/g;
  let addMatch: RegExpExecArray | null;
  while ((addMatch = addRe.exec(xml)) !== null) {
    const attrs = addMatch[1];
    const inner = addMatch[2];
    const rid = attrs.match(/\brequestID="([^"]*)"/)?.[1];
    const localId = rid?.startsWith(ADD_REQUEST_PREFIX) ? rid.slice(ADD_REQUEST_PREFIX.length) : undefined;
    if (!localId) continue;
    const sc = attrs.match(/\bstatusCode="([^"]*)"/)?.[1];
    if (sc && sc !== '0') {
      const msg = attrs.match(/\bstatusMessage="([^"]*)"/)?.[1];
      console.error(`[QBWC] EstimateAdd (create) failed for local draft ${localId}: ${sc} ${msg}`);
      await logDetail(env, 'Estimate', 'push', `Failed to create estimate (local #${localId}) in QuickBooks`, `${sc} ${msg ?? ''}`.trim());
      continue; // pending_add stays true — retried next session
    }
    const ret = blocks(inner, 'EstimateRet')[0];
    if (!ret) continue;
    const parsed = rowFromRet(ret);
    if (!parsed) continue;
    await execQuery(
      env,
      `UPDATE public.qb_estimate SET
         txn_id=$1, edit_sequence=$2, ref_number=$3, customer_list_id=$4, customer_name=$5,
         txn_date=$6, total=$7, lines=$8::jsonb, time_modified=$9, raw=$10::jsonb, memo=$11,
         sales_rep_list_id=$12, sales_rep=$13, pending_add=false, synced_at=CURRENT_TIMESTAMP
       WHERE qb_estimate_id=$14 AND txn_id IS NULL`,
      [...parsed.row, localId],
      'qbwc.estimate.addUpsert'
    );
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (object_type, qb_list_id, qb_edit_sequence, last_synced_at)
       VALUES ('Estimate', $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence=EXCLUDED.qb_edit_sequence, last_synced_at=CURRENT_TIMESTAMP`,
      [parsed.txnId, parsed.row[1]],
      'qbwc.estimate.addMap'
    );
    await logDetail(env, 'Estimate', 'push', `Created estimate ${tag(ret, 'RefNumber') ?? parsed.txnId} in QuickBooks (local #${localId})`);
  }

  for (const [txnId, row] of byId) {
    await execQuery(
      env,
      `INSERT INTO public.qb_estimate
         (txn_id, edit_sequence, ref_number, customer_list_id, customer_name, txn_date,
          total, lines, time_modified, raw, memo, sales_rep_list_id, sales_rep, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13, CURRENT_TIMESTAMP)
       ON CONFLICT (txn_id) DO UPDATE SET
         edit_sequence=EXCLUDED.edit_sequence, ref_number=EXCLUDED.ref_number,
         customer_list_id=EXCLUDED.customer_list_id, customer_name=EXCLUDED.customer_name,
         txn_date=EXCLUDED.txn_date, total=EXCLUDED.total, lines=EXCLUDED.lines,
         time_modified=EXCLUDED.time_modified, raw=EXCLUDED.raw, memo=EXCLUDED.memo,
         sales_rep_list_id=EXCLUDED.sales_rep_list_id, sales_rep=EXCLUDED.sales_rep,
         synced_at=CURRENT_TIMESTAMP`,
      row,
      'qbwc.estimate.upsert'
    );
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (object_type, qb_list_id, qb_edit_sequence, last_synced_at)
       VALUES ('Estimate', $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence=EXCLUDED.qb_edit_sequence, last_synced_at=CURRENT_TIMESTAMP`,
      [txnId, row[1]],
      'qbwc.estimate.map'
    );
  }
}

const estimate: QbObject = {
  name: 'Estimate',
  requestID: REQUEST_ID,
  buildRequest,
  parseResponse,
  iteratorExtra: '      <IncludeLineItems>true</IncludeLineItems>\n',
  incremental: true,
};
export default estimate;
