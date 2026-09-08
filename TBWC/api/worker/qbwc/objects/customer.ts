/**
 * Customer sync (reference implementation).
 *
 * PULL (QB -> TBWC): CustomerQueryRq, optionally incremental via FromModifiedDate
 * (the max time_modified we've already stored). Each CustomerRet is upserted into
 * qb_customer and its ListID/EditSequence recorded in qbwc_map.
 *
 * PUSH (TBWC -> QB): buildRequest also emits CustomerAddRq/CustomerModRq — left as
 * a TODO stub here until the TBWC->QB field mapping is confirmed.
 */
import { Env, execQuery } from '../../db';
import { QbObject } from './types';
import {
  qbxmlDoc, tag, blocks, statusCode, qbTimeToTs, listModifiedFilter, QB_MAX_RETURNED,
  dataExtBlocks,
} from '../qbxml';
import { multiRowValues, chunk, BATCH_SIZE } from '../batchSql';
import { sinceModified } from '../incremental';

const REQUEST_ID = 'customer';

async function buildRequest(env: Env): Promise<string> {
  const fromMod = listModifiedFilter(await sinceModified(env, 'qb_customer', 'qbwc.customer.since'));
  const rq =
    `    <CustomerQueryRq requestID="${REQUEST_ID}" iterator="Start">\n` +
    // qbXML schema order for CustomerQueryRq: MaxReturned, then ActiveStatus,
    // then FromModifiedDate — QB rejects the whole request (0x80040400) if
    // MaxReturned isn't first among these.
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>\n` +
    // All (not ActiveOnly): TBWC's customer counts must include inactive
    // customers to match QuickBooks' own totals.
    // No OwnerID filter: it's GUIDTYPE, not the INTTYPE sentinel we assumed —
    // "-1" is never a valid GUID and made QB fail the whole request ("error
    // converting GUID value \"-1\" in field \"OwnerID\""), same bug as
    // SalesOrder. Means private (non-public) DataExt custom fields won't come
    // back on customers, only OwnerID-0 public ones.
    `      <ActiveStatus>All</ActiveStatus>${fromMod}\n` +
    `    </CustomerQueryRq>`;
  return qbxmlDoc(rq);
  // PUSH TODO: append CustomerAddRq/ModRq for pending TBWC records once mapping known.
}

async function parseResponse(env: Env, xml: string): Promise<void> {
  const status = statusCode(xml, 'CustomerQueryRs');
  // statusCode 1 = "no matching records" (empty result) — not an error.
  if (status && status !== '0' && status !== '1') {
    console.error('[QBWC] CustomerQueryRs status', status);
    return;
  }

  const rets = blocks(xml, 'CustomerRet');
  console.log(`[QBWC] CustomerQueryRs: ${rets.length} customer(s)`);

  // Collect rows, deduped by list_id (last wins) — a duplicate key inside one
  // multi-row upsert makes Postgres error with "cannot affect row a second time".
  const byId = new Map<string, any[]>();
  for (const ret of rets) {
    const listId = tag(ret, 'ListID');
    if (!listId) continue;
    const editSeq = tag(ret, 'EditSequence') ?? null;

    const billAddrBlock = blocks(ret, 'BillAddress')[0];
    const billAddr = billAddrBlock ? JSON.stringify({
      addr1: tag(billAddrBlock, 'Addr1') ?? null,
      addr2: tag(billAddrBlock, 'Addr2') ?? null,
      city: tag(billAddrBlock, 'City') ?? null,
      state: tag(billAddrBlock, 'State') ?? null,
      postal: tag(billAddrBlock, 'PostalCode') ?? null,
    }) : null;

    const isActiveStr = tag(ret, 'IsActive');
    const balanceStr = tag(ret, 'Balance');

    byId.set(listId, [
      listId,
      editSeq,
      tag(ret, 'FullName') ?? null,
      tag(ret, 'Name') ?? null,
      tag(ret, 'CompanyName') ?? null,
      tag(ret, 'FirstName') ?? null,
      tag(ret, 'LastName') ?? null,
      tag(ret, 'Email') ?? null,
      tag(ret, 'Phone') ?? null,
      billAddr,
      isActiveStr == null ? null : isActiveStr === 'true',
      balanceStr == null ? null : Number(balanceStr),
      qbTimeToTs(tag(ret, 'TimeModified')),
      JSON.stringify({ listId, ret: ret.slice(0, 8000) }),
      JSON.stringify(dataExtBlocks(ret)),
    ]);
  }

  // Batched multi-row upserts: execQuery opens a connection per call, so an
  // iterator page must be a handful of statements, not one per record.
  const CASTS = ['', '', '', '', '', '', '', '', '', '::jsonb', '', '', '', '::jsonb', '::jsonb'];
  for (const rows of chunk([...byId.values()], BATCH_SIZE)) {
    await execQuery(
      env,
      `INSERT INTO public.qb_customer
         (list_id, edit_sequence, full_name, name, company_name, first_name,
          last_name, email, phone, bill_addr, is_active, balance, time_modified, raw, data_ext, synced_at)
       VALUES ${multiRowValues(rows.length, CASTS, ', CURRENT_TIMESTAMP')}
       ON CONFLICT (list_id) DO UPDATE SET
         edit_sequence = EXCLUDED.edit_sequence,
         full_name     = EXCLUDED.full_name,
         name          = EXCLUDED.name,
         company_name  = EXCLUDED.company_name,
         first_name    = EXCLUDED.first_name,
         last_name     = EXCLUDED.last_name,
         email         = EXCLUDED.email,
         phone         = EXCLUDED.phone,
         bill_addr     = EXCLUDED.bill_addr,
         is_active     = EXCLUDED.is_active,
         balance       = EXCLUDED.balance,
         time_modified = EXCLUDED.time_modified,
         raw           = EXCLUDED.raw,
         data_ext      = EXCLUDED.data_ext,
         synced_at     = CURRENT_TIMESTAMP`,
      rows.flat(),
      'qbwc.customer.upsert'
    );

    // Record the QB identity so future *ModRq can supply the current EditSequence.
    await execQuery(
      env,
      `INSERT INTO public.qbwc_map (qb_list_id, qb_edit_sequence, object_type, last_synced_at)
       VALUES ${multiRowValues(rows.length, ['', ''], `, 'Customer', CURRENT_TIMESTAMP`)}
       ON CONFLICT (object_type, qb_list_id) DO UPDATE SET
         qb_edit_sequence = EXCLUDED.qb_edit_sequence,
         last_synced_at   = CURRENT_TIMESTAMP`,
      rows.flatMap((r) => [r[0], r[1]]),
      'qbwc.customer.map'
    );
  }
}

const customer: QbObject = {
  name: 'Customer',
  requestID: REQUEST_ID,
  buildRequest,
  parseResponse,
};
export default customer;
