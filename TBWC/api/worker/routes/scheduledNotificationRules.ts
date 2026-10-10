/**
 * Scheduled AI-drafted notification rules — admin CRUD (Settings-gated, same
 * as routes/roles.ts). See framework/backend/api/base/scheduledNotifications.ts
 * for the cron runner that reads these rows; migrations/086-scheduled-
 * notification-rule.sql for the table. TBWC is single-tenant, so there's no
 * tenant_id column — every rule runs globally, mirroring routes/notifications.ts.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { findAll, findById, create, update, remove } from '../crud';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'scheduled_notification_rule';
const PK = 'scheduled_notification_rule_id';
const SEVERITIES = new Set(['info', 'warning', 'error']);

app.get('/', requirePermission('setting:read'), async (c) => {
  const q = c.req.query();
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 100,
    orderBy: `"${TABLE}".created_at DESC`,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', requirePermission('setting:read'), async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Rule not found' }, 404);
  return c.json({ success: true, data: row });
});

function validateBody(body: any): string | null {
  if (!body.name || typeof body.name !== 'string') return 'name is required';
  if (!body.schedule_cron || typeof body.schedule_cron !== 'string') return 'schedule_cron is required';
  if (body.schedule_cron.trim().split(/\s+/).length !== 5) return 'schedule_cron must be a 5-field cron expression';
  if (!body.prompt || typeof body.prompt !== 'string') return 'prompt is required';
  if (body.severity !== undefined && !SEVERITIES.has(body.severity)) return 'severity must be info, warning, or error';
  return null;
}

app.post('/', requirePermission('setting:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const err = validateBody(body);
  if (err) return c.json({ success: false, message: err }, 400);

  const row = await create(c.env, TABLE, {
    name: body.name.trim(),
    schedule_cron: body.schedule_cron.trim(),
    prompt: body.prompt.trim(),
    users_id: body.users_id ?? null,
    severity: body.severity ?? 'info',
    active: body.active ?? true,
  });
  return c.json({ success: true, data: row }, 201);
});

app.put('/:id', requirePermission('setting:write'), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  if (body.severity !== undefined && !SEVERITIES.has(body.severity)) {
    return c.json({ success: false, message: 'severity must be info, warning, or error' }, 400);
  }
  if (body.schedule_cron !== undefined && body.schedule_cron.trim().split(/\s+/).length !== 5) {
    return c.json({ success: false, message: 'schedule_cron must be a 5-field cron expression' }, 400);
  }

  const row = await update(c.env, TABLE, PK, id, {
    name: body.name,
    schedule_cron: body.schedule_cron,
    prompt: body.prompt,
    users_id: body.users_id,
    severity: body.severity,
    active: body.active,
  });
  if (!row) return c.json({ success: false, message: 'Rule not found' }, 404);
  return c.json({ success: true, data: row });
});

app.delete('/:id', requirePermission('setting:write'), async (c) => {
  const row = await remove(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Rule not found' }, 404);
  return c.json({ success: true });
});

export default app;
