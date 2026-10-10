/**
 * Scheduled AI-drafted notification rules — admin CRUD, tenant-scoped same as
 * notificationRules.ts. See framework/backend/api/base/scheduledNotifications.ts
 * for the cron runner that reads these rows; migrations/060-scheduled-
 * notification-rule.sql for the table.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { logError } from '../errorHandler';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const COLS = `scheduled_notification_rule_id, tenant_id, name, schedule_cron, prompt, users_id, severity, active, last_run_at, created_at, updated_at`;
const SEVERITIES = new Set(['info', 'warning', 'error']);

app.get('/', requirePermission('settings:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const result = await execQuery(
      c.env,
      `SELECT ${COLS} FROM public.scheduled_notification_rule WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return c.json({ success: true, data: { items: result.rows, total: result.rows.length } });
  } catch (error: any) {
    logError('Error fetching scheduled notification rules:', error);
    return c.json({ success: false, message: 'Failed to fetch rules' }, 500);
  }
});

app.get('/:id', requirePermission('settings:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    if (isNaN(Number(id))) return c.json({ success: false, message: 'Invalid rule ID' }, 400);

    const result = await execQuery(
      c.env,
      `SELECT ${COLS} FROM public.scheduled_notification_rule WHERE scheduled_notification_rule_id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (result.rows.length === 0) return c.json({ success: false, message: 'Rule not found' }, 404);
    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    logError('Error fetching scheduled notification rule:', error);
    return c.json({ success: false, message: 'Failed to fetch rule' }, 500);
  }
});

app.post('/', requirePermission('settings:update'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const { name, schedule_cron, prompt, users_id, severity = 'info', active = true } = body;

    if (!name) return c.json({ success: false, message: 'name is required' }, 400);
    if (!schedule_cron || schedule_cron.trim().split(/\s+/).length !== 5) {
      return c.json({ success: false, message: 'schedule_cron must be a 5-field cron expression' }, 400);
    }
    if (!prompt) return c.json({ success: false, message: 'prompt is required' }, 400);
    if (!SEVERITIES.has(severity)) return c.json({ success: false, message: 'severity must be info, warning, or error' }, 400);

    const result = await execQuery(
      c.env,
      `INSERT INTO public.scheduled_notification_rule (tenant_id, name, schedule_cron, prompt, users_id, severity, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLS}`,
      [tenantId, name.trim(), schedule_cron.trim(), prompt.trim(), users_id || null, severity, active]
    );
    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (error: any) {
    logError('Error creating scheduled notification rule:', error);
    return c.json({ success: false, message: 'Failed to create rule' }, 500);
  }
});

app.put('/:id', requirePermission('settings:update'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    if (isNaN(Number(id))) return c.json({ success: false, message: 'Invalid rule ID' }, 400);

    const body = await c.req.json().catch(() => ({}));
    const { name, schedule_cron, prompt, users_id, severity, active } = body;
    if (schedule_cron !== undefined && schedule_cron.trim().split(/\s+/).length !== 5) {
      return c.json({ success: false, message: 'schedule_cron must be a 5-field cron expression' }, 400);
    }
    if (severity !== undefined && !SEVERITIES.has(severity)) {
      return c.json({ success: false, message: 'severity must be info, warning, or error' }, 400);
    }

    const updates: string[] = [];
    const values: any[] = [];
    let n = 1;
    if (name !== undefined) { updates.push(`name = $${n}`); values.push(name); n++; }
    if (schedule_cron !== undefined) { updates.push(`schedule_cron = $${n}`); values.push(schedule_cron); n++; }
    if (prompt !== undefined) { updates.push(`prompt = $${n}`); values.push(prompt); n++; }
    if (users_id !== undefined) { updates.push(`users_id = $${n}`); values.push(users_id); n++; }
    if (severity !== undefined) { updates.push(`severity = $${n}`); values.push(severity); n++; }
    if (active !== undefined) { updates.push(`active = $${n}`); values.push(active); n++; }
    if (updates.length === 0) return c.json({ success: false, message: 'No fields to update' }, 400);
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id, tenantId);

    const result = await execQuery(
      c.env,
      `UPDATE public.scheduled_notification_rule SET ${updates.join(', ')}
       WHERE scheduled_notification_rule_id = $${n} AND tenant_id = $${n + 1}
       RETURNING ${COLS}`,
      values
    );
    if (result.rows.length === 0) return c.json({ success: false, message: 'Rule not found' }, 404);
    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    logError('Error updating scheduled notification rule:', error);
    return c.json({ success: false, message: 'Failed to update rule' }, 500);
  }
});

app.delete('/:id', requirePermission('settings:update'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const result = await execQuery(
      c.env,
      `DELETE FROM public.scheduled_notification_rule WHERE scheduled_notification_rule_id = $1 AND tenant_id = $2 RETURNING scheduled_notification_rule_id`,
      [id, tenantId]
    );
    if (result.rows.length === 0) return c.json({ success: false, message: 'Rule not found' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    logError('Error deleting scheduled notification rule:', error);
    return c.json({ success: false, message: 'Failed to delete rule' }, 500);
  }
});

export default app;
