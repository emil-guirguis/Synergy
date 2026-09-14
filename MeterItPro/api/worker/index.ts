/**
 * MeterIt Pro API - Cloudflare Worker Entry Point
 *
 * Hono-based API server deployed on Cloudflare Workers.
 * Mounts all route sub-apps and shared middleware.
 */

import { Hono } from 'hono';
import { runAllActiveReports } from './reportRunner';
import { runAllActiveNotificationRules } from './notificationRunner';
import { runQualityEngine } from './qualityEngine';
import { cors } from 'hono/cors';
import { Env, execQuery } from './db';

import { AuthVariables, authenticateToken } from './middleware';

// Import route modules
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import meterRoutes from './routes/meters';
import locationRoutes from './routes/locations';
import contactRoutes from './routes/contacts';
import deviceRoutes from './routes/devices';
import meterReadingRoutes from './routes/meterReadings';
import meterElementRoutes from './routes/meterElements';
import settingsRoutes from './routes/settings';
import roleRoutes from './routes/roles';
import templateRoutes from './routes/templates';
import emailRoutes from './routes/emails';
import syncRoutes from './routes/sync';
import schemaRoutes from './routes/schema';
import dashboardRoutes from './routes/dashboard';
import favoriteRoutes from './routes/favorites';
import reportRoutes from './routes/reports';
import notificationRoutes from './routes/notifications';
import notificationRulesRoutes from './routes/notificationRules';
import notificationHistoryRoutes from './routes/notificationHistory';
import emailLogRoutes from './routes/emailLogs';
import aiSearchRoutes from './routes/aiSearch';
import aiChatRoutes from './routes/aiChat';
import registerRoutes, { deviceRegistersApp, meterRegistersApp } from './routes/registers';
import uploadRoutes from './routes/upload';
import syncServerRoutes from './routes/syncServers';
import adminRoutes from './routes/adminRoutes';
import supportRoutes from './routes/supportRoutes';
import openapiSpec from './openapi.json';

export const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// --- CORS ---

// Helper to get allowed origins from env
function getAllowedOrigins(env: Env): string[] {
  const frontendUrl = env.FRONTEND_URL || 'https://meteritpro.com';
  return frontendUrl.split(',').map((s: string) => s.trim());
}

app.use('*', cors({
  origin: (origin, c) => {
    const allowedOrigins = getAllowedOrigins(c.env);

    if (!origin) {
      return allowedOrigins[0];
    }

    const isAllowed = allowedOrigins.includes(origin);
    return isAllowed ? origin : allowedOrigins[0];
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key'],
  exposeHeaders: ['Content-Range', 'X-Content-Range', 'X-Request-Id'],
}));

// --- Request ID for correlation across logs ---

app.use('*', async (c, next) => {
  const reqId = c.req.header('x-request-id') || crypto.randomUUID();
  c.set('requestId', reqId);
  await next();
  c.res.headers.set('X-Request-Id', reqId);
});

// --- Global error handler (ensures CORS headers on unhandled errors) ---

app.onError((err, c) => {
  const reqId = c.get('requestId') || 'unknown';
  console.error(`[WORKER] [${reqId}] Unhandled error:`, err);
  console.error(`[WORKER] [${reqId}] Error type:`, err?.constructor?.name);
  console.error(`[WORKER] [${reqId}] Error message:`, err?.message);

  const response = c.json({ success: false, message: 'Internal server error', requestId: reqId }, 500);
  response.headers.set('X-Request-Id', reqId);

  // Add CORS headers manually if needed
  const frontendUrl = c.env.FRONTEND_URL || 'https://meteritpro.com';
  const allowedOrigins = frontendUrl.split(',').map((s: string) => s.trim());
  const origin = c.req.header('origin');

  if (origin && allowedOrigins.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }

  return response;
});

// --- Health check ---

app.get('/api/health', async (c) => {
  try {
    const result = await execQuery(c.env, 'SELECT NOW()');
    return c.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'Connected',
      serverTime: result.rows[0].now,
    });
  } catch (error: any) {
    return c.json({
      status: 'Error',
      timestamp: new Date().toISOString(),
      database: 'Disconnected',
      error: error.message,
    }, 500);
  }
});

// --- API Documentation ---

// Serve Swagger UI HTML
app.get('/swagger', (c) => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>MeterIt Pro Client API Documentation</title>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/swagger-ui.css">
        <link rel="icon" type="image/png" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/favicon-32x32.png" sizes="32x32" />
        <link rel="icon" type="image/png" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/favicon-16x16.png" sizes="16x16" />
        <style>
          html {
            box-sizing: border-box;
            overflow: -moz-scrollbars-vertical;
            overflow-y: scroll;
          }
          *,
          *:before,
          *:after {
            box-sizing: inherit;
          }
          body {
            margin: 0;
            background: #fafafa;
          }
        </style>
      </head>
      <body>
        <div id="swagger-ui"></div>
        <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/swagger-ui-bundle.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/swagger-ui-standalone-preset.js"></script>
        <script>
          window.onload = function() {
            window.ui = SwaggerUIBundle({
              urls: [ { url: "/swagger/spec.json", name: "MeterIt Pro Client API" } ],
              dom_id: '#swagger-ui',
              deepLinking: true,
              presets: [
                SwaggerUIBundle.presets.apis,
                SwaggerUIStandalonePreset
              ],
              plugins: [
                SwaggerUIBundle.plugins.DownloadUrl
              ],
              layout: "StandaloneLayout"
            });
          };
        </script>
      </body>
    </html>
  `;
  return c.html(html);
});

// Serve OpenAPI spec (sourced from openapi.json in this dir)
app.get('/swagger/spec.json', (c) => c.json(openapiSpec));

// --- Mount route sub-apps ---

// Nested routes registered BEFORE parents so Hono matches them first.
// Otherwise `/api/meters/:meterId/elements` is swallowed by `/api/meters`.
app.route('/api/meters/:meterId/elements', meterElementRoutes);
app.route('/api/meters/:meterId/registers', meterRegistersApp);
app.route('/api/devices/:deviceId/registers', deviceRegistersApp);

app.route('/api/auth', authRoutes);
app.route('/api/users', userRoutes);
app.route('/api/meters', meterRoutes);
app.route('/api/location', locationRoutes);
app.route('/api/contacts', contactRoutes);
app.route('/api/device', deviceRoutes);
app.route('/api/meterreadings', meterReadingRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/roles', roleRoutes);
app.route('/api/templates', templateRoutes);
app.route('/api/emails', emailRoutes);
app.route('/api/sync', syncRoutes);
app.route('/api/schema', schemaRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/favorites', favoriteRoutes);
app.route('/api/ai/search', aiSearchRoutes);
app.route('/api/ai/chat', aiChatRoutes);
app.route('/api/reports', reportRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/notification-rules', notificationRulesRoutes);
app.route('/api/notification-history', notificationHistoryRoutes);
app.route('/api/email-logs', emailLogRoutes);
app.route('/api/registers', registerRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/sync-servers', syncServerRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/support', supportRoutes);

// --- Security.txt ---

app.get('/.well-known/security.txt', (c) => {
  const body = [
    'Contact: mailto:emilguirguis.eg@gmail.com',
    'Expires: 2027-01-01T00:00:00.000Z',
    'Preferred-Languages: en',
  ].join('\n');
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
});

// --- Catch-all ---

app.all('*', (c) => {
  return c.json({ success: false, message: 'Route not found' }, 404);
});

// --- Cron trigger (Cloudflare scheduled event) --------------------------------
// Runs every 15 min per wrangler.toml [triggers] crons setting.
// Executes all active reports whose schedule matches the current time.

export default {
  fetch: app.fetch,
  async scheduled(_event: { scheduledTime: number }, env: Env, ctx: { waitUntil(p: Promise<any>): void }) {
    const now = new Date(_event.scheduledTime);
    ctx.waitUntil(Promise.all([
      runAllActiveReports(env, now).catch(err =>
        console.error('[cron] runAllActiveReports failed:', err instanceof Error ? err.message : err)
      ),
      // Quality engine maintains gap/watermark state that notification rules
      // read, so it must complete before the rules run.
      runQualityEngine(env)
        .catch(err =>
          console.error('[cron] runQualityEngine failed:', err instanceof Error ? err.message : err)
        )
        .then(() => runAllActiveNotificationRules(env, now))
        .catch(err =>
          console.error('[cron] runAllActiveNotificationRules failed:', err instanceof Error ? err.message : err)
        ),
    ]));
  },
};
