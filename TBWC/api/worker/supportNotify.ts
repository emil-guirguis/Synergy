/**
 * Automated email alerts for the Support Ticket lifecycle (received / status
 * change / assigned). Fire-and-forget: every function swallows its own
 * sendMail failures (same pattern as reverification.ts's lockStaleReps) so a
 * dead mail path never fails the ticket CRUD request — callers in
 * routes/support.ts run these via `c.executionCtx.waitUntil(...)` so the
 * response doesn't wait on the SMTP round trip either.
 */
import { Env, execQuery } from './db';
import { sendMail } from './mail';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function ticketUrl(env: Env, id: number | string): string {
  const portalUrl = (env.PORTAL_URL || '/').replace(/\/*$/, '/');
  return `${portalUrl}support/${id}`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b4e57;">${text}</p>`;
}

function viewTicketButton(url: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#2f5bd6" style="border-radius:7px;">` +
    `<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:7px;">View ticket</a>` +
    `</td></tr></table>`
  );
}

interface TicketForNotify {
  support_ticket_id: number;
  title: string;
  type: string;
  priority: string;
  status: string;
}

async function adminRecipients(env: Env): Promise<{ email: string; first_name: string | null }[]> {
  const { rows } = await execQuery(
    env,
    `SELECT DISTINCT u.email, u.first_name
       FROM public.users u
       JOIN public.role_permission rp ON rp.role_id = u.role_id
      WHERE rp.permission = 'support:write' AND u.email IS NOT NULL`,
    [],
    'supportNotify.adminRecipients'
  );
  return rows;
}

/** New ticket filed — emails the filer (confirmation) and every support admin (heads-up). */
export async function notifyTicketCreated(
  env: Env,
  ticket: TicketForNotify,
  filer: { email: string | null; first_name: string | null }
): Promise<void> {
  const url = ticketUrl(env, ticket.support_ticket_id);
  const filerName = filer.first_name || 'there';

  if (filer.email) {
    const body =
      paragraph(`Hi ${escapeHtml(filerName)},`) +
      paragraph(`We've received your support ticket <strong>#${ticket.support_ticket_id} — ${escapeHtml(ticket.title)}</strong>. We'll follow up as soon as someone picks it up.`) +
      viewTicketButton(url);
    try {
      await sendMail(env, { type: 'document', email: filer.email, subject: `We received your ticket #${ticket.support_ticket_id}`, bodyHtml: body });
    } catch (e) {
      console.error(`[supportNotify] created->filer failed for ${filer.email}:`, e instanceof Error ? e.message : e);
    }
  }

  const admins = await adminRecipients(env);
  if (!admins.length) return;
  const adminBody =
    paragraph(`New support ticket filed by ${escapeHtml(filer.first_name || 'a user')}:`) +
    paragraph(`<strong>#${ticket.support_ticket_id} — ${escapeHtml(ticket.title)}</strong> (${escapeHtml(ticket.type)}, ${escapeHtml(ticket.priority)} priority)`) +
    viewTicketButton(url);
  for (const admin of admins) {
    try {
      await sendMail(env, { type: 'document', email: admin.email, subject: `New ticket #${ticket.support_ticket_id} — ${ticket.title}`, bodyHtml: adminBody });
    } catch (e) {
      console.error(`[supportNotify] created->admin failed for ${admin.email}:`, e instanceof Error ? e.message : e);
    }
  }
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed',
};

/** Ticket status changed — emails the filer. Worded a little differently once it's resolved/closed. */
export async function notifyTicketStatusChanged(
  env: Env,
  ticket: TicketForNotify,
  filer: { email: string | null; first_name: string | null },
  newStatus: string
): Promise<void> {
  if (!filer.email) return;
  const url = ticketUrl(env, ticket.support_ticket_id);
  const label = STATUS_LABELS[newStatus] || newStatus;
  const closing = newStatus === 'resolved' || newStatus === 'closed';
  const body =
    paragraph(`Hi ${escapeHtml(filer.first_name || 'there')},`) +
    paragraph(
      closing
        ? `Your ticket <strong>#${ticket.support_ticket_id} — ${escapeHtml(ticket.title)}</strong> has been marked <strong>${escapeHtml(label)}</strong>. If this didn't actually resolve things, just reply to reopen it.`
        : `Your ticket <strong>#${ticket.support_ticket_id} — ${escapeHtml(ticket.title)}</strong> is now <strong>${escapeHtml(label)}</strong>.`
    ) +
    viewTicketButton(url);
  try {
    await sendMail(env, { type: 'document', email: filer.email, subject: `Ticket #${ticket.support_ticket_id}: ${label}`, bodyHtml: body });
  } catch (e) {
    console.error(`[supportNotify] status->filer failed for ${filer.email}:`, e instanceof Error ? e.message : e);
  }
}

/** Ticket (re)assigned — emails the new assignee. */
export async function notifyTicketAssigned(
  env: Env,
  ticket: TicketForNotify,
  assignee: { email: string | null; first_name: string | null }
): Promise<void> {
  if (!assignee.email) return;
  const url = ticketUrl(env, ticket.support_ticket_id);
  const body =
    paragraph(`Hi ${escapeHtml(assignee.first_name || 'there')},`) +
    paragraph(`You've been assigned ticket <strong>#${ticket.support_ticket_id} — ${escapeHtml(ticket.title)}</strong> (${escapeHtml(ticket.priority)} priority).`) +
    viewTicketButton(url);
  try {
    await sendMail(env, { type: 'document', email: assignee.email, subject: `Assigned to you: ticket #${ticket.support_ticket_id}`, bodyHtml: body });
  } catch (e) {
    console.error(`[supportNotify] assigned failed for ${assignee.email}:`, e instanceof Error ? e.message : e);
  }
}
