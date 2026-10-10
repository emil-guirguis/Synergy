/**
 * TBWC API — Cloudflare Worker entry (Hono).
 * Mirrors the MeterItPro worker: CORS, health, and mounted route sub-apps that
 * serve schema JSON + REST CRUD to the shared framework frontend.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, execQuery } from './db';
import { AuthVariables } from './middleware';

import authRoutes from './routes/auth';
import schemaRoutes from './routes/schema';
import userRoutes from './routes/users';
import peopleRoutes from './routes/people';
import userManagerRoutes from './routes/userManagers';
import orderRoutes from './routes/orders';
import inventoryRoutes from './routes/inventory';
import quoteRoutes from './routes/quotes';
import customerRoutes from './routes/customers';
import invoiceRoutes from './routes/invoices';
import paymentRoutes from './routes/payments';
import repPerformanceRoutes from './routes/repPerformance';
import orderToCashRoutes from './routes/orderToCash';
import invoiceTotalsRoutes from './routes/invoiceTotals';
import settingsRoutes from './routes/settings';
import roleRoutes from './routes/roles';
import qbwcRoutes from './routes/qbwc';
import qbSyncRoutes from './routes/qbSync';
import verifyRoutes from './routes/verify';
import docTypeRoutes from './routes/docTypes';
import documentRoutes from './routes/documents';
import notificationRoutes from './routes/notifications';
import scheduledNotificationRuleRoutes from './routes/scheduledNotificationRules';
import aiChatRoutes from './routes/aiChat';
import aiSearchRoutes from './routes/aiSearch';
import aiMemoryRoutes from './routes/aiMemory';
import supportRoutes from './routes/support';
import contactRoutes from './routes/contact';
import { lockStaleReps } from './reverification';
import { handleInboundEmail, type InboundEmailMessage } from './emailToTicket';
import { runScheduledNotifications } from '@meterit/framework-backend/api/base/scheduledNotifications';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function allowedOrigins(env: Env): string[] {
  const fe = env.FRONTEND_URL || 'http://localhost:5174';
  return fe.split(',').map((s) => s.trim());
}

// tbwc-site (the public marketing site, not the portal) posts here anonymously
// — a different origin than FRONTEND_URL, and this is the single cors()
// middleware for the whole Worker (Hono's cors() answers an OPTIONS preflight
// itself and never calls next(), so a second cors() mounted only on
// routes/contact.ts would never even run for the preflight — the outer one
// always owns it). Path-gated here instead of broadening the main allowlist.
function publicSiteOrigins(env: Env): string[] {
  // tbwc-site's `npm run dev` (scripts/dev.js) always serves on :3000.
  const site = env.PUBLIC_SITE_URL || 'http://localhost:3000';
  return site.split(',').map((s) => s.trim());
}

app.use('*', cors({
  origin: (origin, c) => {
    const allowed = c.req.path.startsWith('/api/contact') ? publicSiteOrigins(c.env) : allowedOrigins(c.env);
    if (!origin) return allowed[0];
    return allowed.includes(origin) ? origin : allowed[0];
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.onError((err, c) => {
  console.error('[TBWC WORKER] Unhandled error:', err);
  return c.json({ success: false, message: 'Internal server error' }, 500);
});

app.get('/api/health', async (c) => {
  try {
    const r = await execQuery(c.env, 'SELECT NOW()');
    return c.json({ status: 'OK', database: 'Connected', serverTime: r.rows[0].now });
  } catch (e: any) {
    return c.json({ status: 'Error', message: e.message }, 500);
  }
});

app.route('/api/auth', authRoutes);
app.route('/api/schema', schemaRoutes);
app.route('/api/users', userRoutes);
app.route('/api/people', peopleRoutes);
app.route('/api/user-managers', userManagerRoutes);
app.route('/api/orders', orderRoutes);
app.route('/api/inventory', inventoryRoutes);
app.route('/api/quotes', quoteRoutes);
app.route('/api/customers', customerRoutes);
app.route('/api/invoices', invoiceRoutes);
app.route('/api/payments', paymentRoutes);
app.route('/api/reports/rep-performance', repPerformanceRoutes);
app.route('/api/reports/order-to-cash', orderToCashRoutes);
app.route('/api/reports/invoice-totals', invoiceTotalsRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/roles', roleRoutes);
app.route('/api/doc-types', docTypeRoutes);
app.route('/api/documents', documentRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/scheduled-notification-rules', scheduledNotificationRuleRoutes);
app.route('/api/support', supportRoutes);
// Public, unauthenticated — see routes/contact.ts's header comment.
app.route('/api/contact', contactRoutes);
app.route('/api/qb-sync', qbSyncRoutes);
app.route('/api/ai/chat', aiChatRoutes);
app.route('/api/ai/search', aiSearchRoutes);
app.route('/api/ai/memory', aiMemoryRoutes);
// QuickBooks Web Connector SOAP endpoint (no Supabase auth — QBWC is not a browser
// and authenticates with its own username/password inside the SOAP body).
app.route('/qbwc', qbwcRoutes);
// Re-verification link click (no Supabase auth — the token param is the credential).
app.route('/api/verify', verifyRoutes);

export default {
  fetch: app.fetch,
  // Runs on the schedule in wrangler.toml [triggers]/[env.production.triggers]
  // (*/15 * * * * — bumped from daily so scheduled_notification_rule crons can
  // fire on their own cadence; lockStaleReps' WHERE clause is idempotent, so
  // running it every 15 min instead of once a day is harmless).
  async scheduled(event: { scheduledTime: number }, env: Env, ctx: { waitUntil(p: Promise<any>): void }) {
    const now = new Date(event.scheduledTime);
    ctx.waitUntil(
      lockStaleReps(env).catch((err) =>
        console.error('[cron] lockStaleReps failed:', err instanceof Error ? err.message : err)
      )
    );
    ctx.waitUntil(
      runScheduledNotifications(execQuery, env, now, { tenantColumn: null, notificationOptions: { tenantColumn: null } }).catch((err) =>
        console.error('[cron] runScheduledNotifications failed:', err instanceof Error ? err.message : err)
      )
    );
  },
  // Cloudflare Email Routing -> "Send to a Worker" for
  // support@tickets.tbwctechnology.com (set up in the CF dashboard, not here).
  // See emailToTicket.ts's header comment for the full setup note.
  async email(message: InboundEmailMessage, env: Env) {
    await handleInboundEmail(message, env);
  },
};
