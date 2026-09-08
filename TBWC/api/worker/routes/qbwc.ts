/**
 * QuickBooks Web Connector SOAP endpoint.
 *
 *   GET  /qbwc?wsdl   -> WSDL document (QBWC downloads this on Add/verify)
 *   POST /qbwc        -> SOAP dispatch for the 8 QBWC operations
 *
 * Flow: authenticate -> (sendRequestXML -> receiveResponseXML)* -> closeConnection.
 * The work queue and cursor live in public.qbwc_session so state survives across
 * Cloudflare isolates. Each queued item is a qbXML request built by an object
 * module (see qbwc/objects); responses are routed back to the owning parser.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables } from '../middleware';
import { buildWsdl } from '../qbwc/wsdl';
import {
  parseMethod, getParam, envelope, authEnvelope, xmlEscape,
} from '../qbwc/soap';
import {
  createSession, getSession, dropSession, advanceCursor, insertAfterCursor,
} from '../qbwc/session';
import { buildWorkQueue, dispatchResponse, registry } from '../qbwc/objects';
import { logResponse, logError } from '../qbwc/syncLog';
import { pendingIterator, iteratorContinueDoc } from '../qbwc/qbxml';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// QBWC credentials. Prod reads from `wrangler secret` (QBWC_USERNAME / QBWC_PASSWORD)
// via c.env; these are the local-dev fallbacks used only when the secrets are unset.
const DEV_QBWC_USERNAME = 'tbwc';
const DEV_QBWC_PASSWORD = 'changeme';

/** GET /qbwc?wsdl (or ?WSDL) -> WSDL; plain GET -> liveness text. */
app.get('/', (c) => {
  const url = new URL(c.req.url);
  const wantsWsdl = [...url.searchParams.keys()].some((k) => k.toLowerCase() === 'wsdl');
  const serviceUrl = `${url.origin}${url.pathname}`;
  if (wantsWsdl) {
    return c.body(buildWsdl(serviceUrl), 200, { 'Content-Type': 'text/xml; charset=utf-8' });
  }
  return c.text('QBWC SOAP endpoint. Append ?wsdl for the service description.');
});

// Target of <AppSupport> in tbwc.qwc. The Web Connector rejects an app whose
// support URL is on a different domain than <AppURL> (QBWC1000), so this has to
// live under the Worker origin rather than the marketing site.
app.get('/support', (c) =>
  c.text('TBWC QuickBooks Sync support — contact the TBWC portal administrator.'));

app.post('/', async (c) => {
  const body = await c.req.text();
  const method = parseMethod(body);
  const reply = (xml: string) =>
    c.body(xml, 200, { 'Content-Type': 'text/xml; charset=utf-8' });

  switch (method) {
    // --- version handshake -------------------------------------------------
    case 'serverVersion':
      return reply(envelope('serverVersion', xmlEscape('1.0.0')));
    case 'clientVersion':
      // Empty string = accept the connector's version with no warning.
      return reply(envelope('clientVersion', ''));

    // --- authenticate ------------------------------------------------------
    case 'authenticate': {
      const user = getParam(body, 'strUserName');
      const pass = getParam(body, 'strPassword');
      const ticket = crypto.randomUUID();

      // .trim(): secrets piped to `wrangler secret put` on Windows can pick up
      // a trailing CRLF, which made every QBWC login fail with "invalid password".
      const expectUser = (c.env.QBWC_USERNAME || DEV_QBWC_USERNAME).trim();
      const expectPass = (c.env.QBWC_PASSWORD || DEV_QBWC_PASSWORD).trim();
      if (user !== expectUser || pass !== expectPass) {
        // [ticket, "nvu"] = invalid user; QBWC aborts the session.
        return reply(authEnvelope([ticket, 'nvu']));
      }

      const queue = await buildWorkQueue(c.env);
      await createSession(c.env, ticket, queue);
      // Second element tells QBWC which company file to work against:
      //   "none"      = no work this session
      //   ""          = whatever file is already open in QuickBooks (attended)
      //   "<path>"    = full path to a .qbw; QBWC starts QuickBooks and opens it
      //                 itself, so no one has to have QB running (unattended).
      // Unattended also requires the app to be authorized in QB with "allow access
      // even if QuickBooks is not running" — the path alone is not enough.
      const status = queue.length === 0 ? 'none' : (c.env.QBWC_COMPANY_FILE || '');
      return reply(authEnvelope([ticket, status]));
    }

    // --- work loop ---------------------------------------------------------
    case 'sendRequestXML': {
      const ticket = getParam(body, 'ticket');
      const s = await getSession(c.env, ticket);
      if (!s || s.cursor >= s.queue.length) {
        return reply(envelope('sendRequestXML', '')); // empty => nothing more to send
      }
      const qbxml = s.queue[s.cursor];
      return reply(envelope('sendRequestXML', xmlEscape(qbxml)));
    }

    case 'receiveResponseXML': {
      const ticket = getParam(body, 'ticket');
      const response = getParam(body, 'response');
      const hresult = getParam(body, 'hresult');
      const s = await getSession(c.env, ticket);
      if (!s) return reply(envelope('receiveResponseXML', '100'));

      let errMsg: string | undefined;
      let queueLen = s.queue.length;
      if (hresult) {
        errMsg = getParam(body, 'message') || hresult;
        console.error('[QBWC] request error', hresult, errMsg);
        // Attribute the failure to the object whose request was in flight
        // (requestID attr of the queue item the cursor points at).
        const rid = s.queue[s.cursor]?.match(/requestID="([A-Za-z]+)/)?.[1];
        // Resolve via the registry so e.g. rid "salesrep" logs as "SalesRep".
        const objectType = registry.find((o) => o.requestID === rid)?.name
          ?? (rid ? rid.charAt(0).toUpperCase() + rid.slice(1) : 'Connection');
        await logError(c.env, ticket, objectType, `${hresult}: ${errMsg}`);
      } else {
        await dispatchResponse(c.env, response);
        await logResponse(c.env, ticket, response);
        // QB caps a single un-iterated Query response; if it says more rows are
        // waiting, queue a Continue request right after this one so the next
        // poll fetches the next page instead of the session ending short.
        const pending = pendingIterator(response);
        if (pending) {
          const owner = registry.find(
            (o) => pending.requestID === o.requestID || pending.requestID.startsWith(o.requestID + ':')
          );
          const continueDoc = iteratorContinueDoc(
            pending.rqName, pending.requestID, pending.iteratorId, owner?.iteratorExtra ?? ''
          );
          queueLen = await insertAfterCursor(c.env, ticket, s.cursor, continueDoc);
        }
      }
      const newCursor = await advanceCursor(c.env, ticket, errMsg);

      // Return percent complete: <100 keeps the loop going, 100 ends it.
      // queueLen reflects any iterator Continue page just spliced in, so an
      // in-progress large pull never gets reported as 100% early.
      const pct = queueLen === 0
        ? 100
        : Math.floor((newCursor / queueLen) * 100);
      return reply(envelope('receiveResponseXML', String(pct)));
    }

    // --- errors + teardown -------------------------------------------------
    case 'getLastError': {
      const ticket = getParam(body, 'ticket');
      const s = await getSession(c.env, ticket);
      return reply(envelope('getLastError', xmlEscape(s?.lastError || 'No error')));
    }

    case 'connectionError': {
      const ticket = getParam(body, 'ticket');
      const msg = getParam(body, 'message');
      console.error('[QBWC] connectionError:', msg);
      await logError(c.env, ticket, 'Connection', msg || 'connectionError');
      // "done" tells QBWC to stop; "" would ask it to retry.
      return reply(envelope('connectionError', 'done'));
    }

    case 'closeConnection': {
      const ticket = getParam(body, 'ticket');
      await dropSession(c.env, ticket);
      return reply(envelope('closeConnection', 'OK'));
    }

    default:
      console.error('[QBWC] Unrecognized SOAP method. Body head:', body.slice(0, 300));
      return c.text('Unrecognized QBWC method', 400);
  }
});

export default app;
