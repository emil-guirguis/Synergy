/**
 * Server-side caller for the tbwc-site Supabase edge fn `send-mail`.
 * Mirrors the frontend's repLeadsService.approveLead, which calls the same
 * fn with the admin's own access token — the cron has no browser session to
 * borrow one from, so it authenticates as the service role instead.
 */
import { Env } from './db';

export interface SendMailPayload {
  type: string;
  email: string;
  firstName?: string | null;
  /** Required by the invite/reverify templates; the 'document' type below
   *  doesn't use it. */
  link?: string;
  /** 'document' type only — caller (this Worker) renders its own subject/body
   *  and the edge fn just brands+sends it, see TBWC's send-mail/index.ts. */
  subject?: string;
  bodyHtml?: string;
  /** 'document' type only — where a reply should go, when it shouldn't be
   *  SMTP_FROM (the fixed system account). Requires the send-mail edge
   *  function to read body.replyTo — see tbwc-site's _shared/mailer.ts. */
  replyTo?: string;
  /** 'document' type only — extra recipient on the actual send (e.g. the AR
   *  collection-notice Cc to accounting@tbwcinc.com). Dropped in non-prod —
   *  see DEV_TEST_RECIPIENT below, same reasoning: a real mailbox must never
   *  receive test traffic. */
  cc?: string;
  attachmentBase64?: string;
  attachmentFilename?: string;
  attachmentContentType?: string;
}

// Outside of production, every email this Worker sends — invites,
// reverification, order/invoice PDFs, AR collection notices, everything —
// goes to this address instead of whoever the caller named, so testing a
// send feature locally (or against a staging deploy) can never actually
// reach a real customer or rep. Not a secret, so it's fine to hardcode: it's
// a safety rail, not a credential.
const DEV_TEST_RECIPIENT = 'emilguirguis@yahoo.com';

export async function sendMail(env: Env, payload: SendMailPayload): Promise<void> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');

  // env.ENVIRONMENT is "production" only for the deployed production Worker
  // (wrangler.toml's [env.production.vars]) — local `wrangler dev` and
  // anything else redirects. The real recipient still shows up in the
  // subject so a tester can tell whose email they're looking at.
  const isProd = env.ENVIRONMENT === 'production';
  const outgoing: SendMailPayload = isProd
    ? payload
    : { ...payload, email: DEV_TEST_RECIPIENT, cc: undefined, subject: payload.subject ? `[dev → ${payload.email}] ${payload.subject}` : payload.subject };

  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/send-mail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(outgoing),
  });
  if (!res.ok) {
    throw new Error(`send-mail failed (${res.status}): ${await res.text().catch(() => '')}`);
  }
}
