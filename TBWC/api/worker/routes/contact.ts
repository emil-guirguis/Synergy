/**
 * Public contact form intake — tbwc-site's "Contact Us" form (unauthenticated
 * visitor, no portal login) POSTs here and it becomes an ordinary
 * support_ticket row (users_id NULL — anonymous), same table/admin inbox as
 * portal-filed tickets and (eventually) inbound email-to-ticket. Reuses
 * notifyTicketCreated for the "we got it" + admin-heads-up emails, same as a
 * logged-in filer gets.
 *
 * No authenticateToken here (there's no caller to authenticate). CORS for
 * this path is handled in index.ts's single global cors() (path-gated to
 * PUBLIC_SITE_URL instead of the portal-only FRONTEND_URL) — not duplicated
 * here, since Hono's cors() answers an OPTIONS preflight itself without
 * calling next(), so a second cors() mounted only on this sub-app would never
 * even run for the preflight.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { create } from '../crud';
import { ipRateLimit } from '@meterit/framework-backend/api/base/auth';
import { notifyTicketCreated } from '../supportNotify';

const app = new Hono<{ Bindings: Env }>();

// 5 submissions/minute/IP — enough for a real visitor retrying a typo'd
// email, not enough for a scripted flood. See auth.ts's in-isolate limiter.
app.use('*', ipRateLimit(5, 60_000) as any);

const MAX_FIELD = 2000;

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { name, email, message, subject } = body;

  // Honeypot: a real visitor never fills a field hidden via CSS, a bot
  // filling every field it sees will. Pretend success either way so a bot
  // doesn't learn to leave it blank.
  if (body.company) return c.json({ success: true });

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return c.json({ success: false, message: 'Name, email, and message are required' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return c.json({ success: false, message: 'Enter a valid email address' }, 400);
  }

  const title = (subject?.trim() || `Contact form inquiry from ${name.trim()}`).slice(0, 200);
  const description = `From: ${name.trim()} <${email.trim()}>\n\n${message.trim()}`.slice(0, MAX_FIELD);

  const row = await create(c.env, 'support_ticket', {
    users_id: null,
    title,
    description,
    type: 'general',
    priority: 'medium',
    status: 'open',
  });

  c.executionCtx.waitUntil(
    notifyTicketCreated(c.env, row, { email: email.trim(), first_name: name.trim().split(' ')[0] }).catch((e) =>
      console.error('[contact] notifyTicketCreated failed:', e instanceof Error ? e.message : e)
    )
  );

  return c.json({ success: true, data: { ticketId: row.support_ticket_id } }, 201);
});

export default app;
