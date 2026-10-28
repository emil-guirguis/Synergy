/**
 * Microsoft Graph change-notification endpoint for Excel Online edit sessions
 * (officeEditSync.ts). Unauthenticated by necessity: Graph calls it from
 * Microsoft's network with no TBWC credential of any kind.
 *
 * What stands in for auth is clientState — a per-session secret minted at
 * open() time, stored only in office_edit_session, and echoed back by Graph on
 * every notification. A notification whose clientState doesn't match the
 * subscription's row is dropped, so knowing (or guessing) a subscription id is
 * not enough to make this route pull bytes.
 *
 * Graph retries on anything but a 2xx and gives up on a slow endpoint, so the
 * response goes out immediately and the actual download happens in waitUntil.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { pullBack, sessionForNotification } from '../officeEditSync';

const app = new Hono<{ Bindings: Env }>();

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
}

app.post('/', async (c) => {
  // Subscription handshake: Graph POSTs an empty body with this query param and
  // wants it echoed back verbatim as text/plain, or the subscription is refused.
  const validationToken = c.req.query('validationToken');
  if (validationToken) return c.text(validationToken, 200);

  const body = await c.req
    .json<{ value?: GraphNotification[] }>()
    .catch((): { value?: GraphNotification[] } => ({}));
  const notifications = Array.isArray(body.value) ? body.value : [];

  for (const n of notifications) {
    if (!n.subscriptionId || !n.clientState) continue;
    const session = await sessionForNotification(c.env, n.subscriptionId, n.clientState);
    if (!session) {
      console.warn('[officeEditWebhook] notification for unknown or mismatched subscription — dropped');
      continue;
    }
    c.executionCtx.waitUntil(
      pullBack(c.env, session).catch((e) =>
        console.error('[officeEditWebhook] pull-back failed:', e instanceof Error ? e.message : e)
      )
    );
  }

  return c.body(null, 202);
});

export default app;
