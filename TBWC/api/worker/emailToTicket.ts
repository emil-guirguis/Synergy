/**
 * Email-to-Ticket — Cloudflare Email Routing delivers mail sent to
 * support@tickets.tbwctechnology.com straight to this Worker (see index.ts's
 * `email` export, Cloudflare's inbound handler contract). Each message
 * becomes an ordinary anonymous support_ticket row, same path as the public
 * contact form (routes/contact.ts) and a portal-filed ticket — one inbox,
 * three ways in.
 *
 * Setup (outside this codebase, done once in the Cloudflare dashboard):
 * Email Routing -> Routes -> add support@tickets.tbwctechnology.com ->
 * "Send to a Worker" -> this Worker (tbwc-api). Requires DNS for
 * tbwctechnology.com to already be on Cloudflare (it is).
 *
 * v1 scope: subject + plain-text body only — attachments on the inbound
 * email are not pulled into the ticket's Documents tab. postal-mime parses
 * them (email.attachments) if that's wanted later; skipped here to keep this
 * additive rather than another document-upload pipeline to secure.
 */
import PostalMime from 'postal-mime';
import { Env } from './db';
import { create } from './crud';
import { notifyTicketCreated } from './supportNotify';

export interface InboundEmailMessage {
  raw: ReadableStream<Uint8Array>;
  from: string;
  to: string;
  rawSize: number;
  setReject(reason: string): void;
}

const MAX_DESCRIPTION = 4000;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function handleInboundEmail(message: InboundEmailMessage, env: Env): Promise<void> {
  try {
    const email = await PostalMime.parse(message.raw);
    const fromAddress = (email.from?.address || message.from || '').trim();
    if (!fromAddress) {
      console.error('[emailToTicket] inbound message had no usable From address — dropped');
      return;
    }
    const fromName = email.from?.name?.trim() || fromAddress.split('@')[0];
    const title = (email.subject?.trim() || `Email from ${fromName}`).slice(0, 200);
    const bodyText = (email.text?.trim() || stripHtml(email.html || '')).slice(0, MAX_DESCRIPTION);

    const row = await create(env, 'support_ticket', {
      users_id: null,
      title,
      description: bodyText || '(no message body)',
      type: 'general',
      priority: 'medium',
      status: 'open',
    });

    await notifyTicketCreated(env, row, { email: fromAddress, first_name: fromName }).catch((e) =>
      console.error('[emailToTicket] notifyTicketCreated failed:', e instanceof Error ? e.message : e)
    );
  } catch (e) {
    // Swallowed on purpose — throwing here would have Cloudflare treat the
    // message as failed/bounced, and a malformed inbound email isn't
    // something retrying fixes.
    console.error('[emailToTicket] failed to process inbound email:', e instanceof Error ? e.message : e);
  }
}
