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
import item from './item';
// Parked until proven. Re-add to `registry` to enable.
// import vendor from './vendor';
// import invoice from './invoice';
// import payment from './payment';
// import estimate from './estimate';

// Scope: Customer + SalesRep + Item + SalesOrder (per current sync target). The
// other objects (vendor/invoice/payment/estimate) are implemented but held out
// of the queue so they can't error the session — re-add when ready.
// Order matters: lists before any transactions that reference them.
export const registry: QbObject[] = [
  customer,
  salesRep,
  item,
  salesOrder,
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
