/**
 * Object registry. buildWorkQueue asks every registered object for its qbXML
 * request(s); dispatchResponse routes a *Rs response back to the owning object by
 * the requestID QB echoes on the response element.
 *
 * Add new objects (Invoice, Item, Vendor, Bill, Payment, …) by implementing
 * QbObject and appending to `registry`.
 */
import { Env } from '../../db';
import { QbObject } from './types';
import customer from './customer';
import salesRep from './salesRep';
import salesOrder from './salesOrder';
import txnDeleted from './txnDeleted';
import listDeleted from './listDeleted';
import item from './item';
import invoice from './invoice';
// Parked until proven. Re-add to `registry` to enable.
// import vendor from './vendor';
// import payment from './payment';
// import estimate from './estimate';

// Scope: Customer + SalesRep + Item + SalesOrder + Invoice (per current sync
// target). The other objects (vendor/payment/estimate) are implemented but
// held out of the queue so they can't error the session — re-add when ready.
// Order matters: lists before any transactions that reference them, and both
// deletion sweeps last so a record deleted in the same session as it was
// modified ends up marked deleted rather than resurrected by the pull's upsert.
export const registry: QbObject[] = [
  customer,
  salesRep,
  item,
  salesOrder,
  invoice,
  listDeleted,
  txnDeleted,
];

/** Ordered qbXML requests for this session (one per object that has work). */
export async function buildWorkQueue(env: Env): Promise<string[]> {
  const out: string[] = [];
  for (const obj of registry) {
    const rq = await obj.buildRequest(env);
    if (rq && rq.trim()) out.push(rq);
  }
  return out;
}

/** Extract the requestID attribute QB echoes on the first *Rs element. */
function responseRequestId(xml: string): string | undefined {
  const m = xml.match(/<[A-Za-z]+Rs\b[^>]*\brequestID="([^"]*)"/);
  return m ? m[1] : undefined;
}

/**
 * The incremental object whose pull Query in this response came back fully
 * drained — i.e. a *QueryRs carrying that object's bare requestID (Add/Mod
 * pushes echo "<requestID>:<localId>", so they never match) and a statusCode
 * QB uses for success: 0, or 1 for "no matching records", which is still a
 * complete result set. Callers use it to advance qbwc_pull_cursor; an errored
 * query must not count as drained or it would clear a queued full reload
 * without ever having re-pulled anything.
 * Only meaningful when pendingIterator() found no further pages.
 */
export function drainedQueryOwner(responseXml: string): QbObject | undefined {
  for (const [, base, attrs] of responseXml.matchAll(/<([A-Za-z]+)QueryRs\b([^>]*)>/g)) {
    const rid = attrs.match(/\brequestID="([^"]*)"/)?.[1];
    const obj = registry.find((o) => o.incremental && o.requestID === rid);
    if (!obj) continue;
    const status = attrs.match(/\bstatusCode="([^"]*)"/)?.[1];
    if (status !== undefined && status !== '0' && status !== '1') {
      console.error(`[QBWC] ${base}QueryRs status ${status} — not marking ${obj.name} drained`);
      continue;
    }
    return obj;
  }
  return undefined;
}

/** Route a receiveResponseXML payload to the object whose requestID it carries. */
export async function dispatchResponse(env: Env, responseXml: string): Promise<void> {
  const rid = responseRequestId(responseXml);
  // requestID may be "customer" or "customer:<localId>" for Add/Mod; match prefix.
  const obj = registry.find((o) => rid === o.requestID || rid?.startsWith(o.requestID + ':'));
  if (!obj) {
    console.error('[QBWC] No object for requestID', rid, '— head:', responseXml.slice(0, 200));
    return;
  }
  await obj.parseResponse(env, responseXml);
}
