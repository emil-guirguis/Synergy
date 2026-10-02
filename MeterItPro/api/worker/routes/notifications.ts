/**
 * Notifications routes — thin Hono wrapper over the framework module
 * (@meterit/framework-backend/api/base/notifications). This file owns only
 * what is MeterItPro-specific: auth middleware and the response envelope.
 *
 * Table public.notification, PK notification_id; see
 * migrations/002-create-notification-schema.sql + 046-notification-state.sql.
 * meter_id/meter_element_id live on that table too (set directly by
 * notificationRunner.ts's own SQL, part of the notification-rules domain —
 * out of scope for this generic CRUD/ack layer) and still ride along in every
 * response below since the framework module selects named columns only for
 * its own generic set, so those two are added back explicitly.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';

import { authenticateToken, AuthVariables } from '../middleware';
import { logError } from '../errorHandler';
import {
  listNotifications,
  countNotifications,
  createNotification,
  acknowledgeNotification,
  deleteNotification,
  deleteAllNotifications,
  NotificationValidationError,
} from '@meterit/framework-backend/api/base/notifications';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authenticateToken);

function fail(c: any, e: unknown, fallback: string) {
  if (e instanceof NotificationValidationError) {
    return c.json({ success: false, message: e.message }, 400);
  }
  logError(fallback, e);
  return c.json({ success: false, message: fallback }, 500);
}

// GET /count - Count of visible notifications for current user
app.get('/count', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('user').users_id;
    const count = await countNotifications(execQuery, c.env, tenantId, userId);
    return c.json({ success: true, data: { count } });
  } catch (error) {
    return fail(c, error, 'Failed to count notifications');
  }
});

// GET / - List notifications for current user
app.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('user').users_id;
    const qs = c.req.query();
    const limit = Math.min(parseInt(qs.limit || '100') || 100, 200);
    const offset = parseInt(qs.offset || '0') || 0;

    const { notifications, total } = await listNotifications(execQuery, c.env, tenantId, userId, { limit, offset });
    const withId = notifications.map((row) => ({ ...row, id: String(row.notification_id) }));

    return c.json({ success: true, data: { notifications: withId, total, limit, offset } });
  } catch (error) {
    return fail(c, error, 'Failed to fetch notifications');
  }
});

// POST / - Create a notification
app.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();

    const row = await createNotification(execQuery, c.env, tenantId, {
      notificationType: body.notification_type,
      title: body.title,
      severity: body.severity,
      description: body.description,
      usersId: body.users_id,
    });

    // meter_id/meter_element_id aren't part of the generic module — set them
    // in a follow-up update when the caller (e.g. the MCP create-notification
    // tool's UI-facing twin) supplies them.
    if (body.meter_id != null || body.meter_element_id != null) {
      await execQuery(
        c.env,
        `UPDATE public.notification SET meter_id = $2, meter_element_id = $3 WHERE notification_id = $1`,
        [row.notification_id, body.meter_id ?? null, body.meter_element_id ?? null],
        'notifications.setMeterRef'
      );
    }

    return c.json({ success: true, data: { notification: { ...row, id: String(row.notification_id) } } }, 201);
  } catch (error) {
    return fail(c, error, 'Failed to create notification');
  }
});

// POST /:id/acknowledge - Mark an alert as acknowledged (stops re-notify emails)
app.post('/:id/acknowledge', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('user').users_id;
    const id = c.req.param('id');
    if (isNaN(Number(id))) return c.json({ success: false, message: 'Invalid notification ID' }, 400);

    const row = await acknowledgeNotification(execQuery, c.env, tenantId, id, userId);
    if (!row) return c.json({ success: false, message: 'Notification not found' }, 404);

    return c.json({ success: true, data: { notification: { ...row, id: String(row.notification_id) } } });
  } catch (error) {
    return fail(c, error, 'Failed to acknowledge notification');
  }
});

// DELETE /:id - Hard delete a specific notification (scoped to tenant)
app.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    if (isNaN(Number(id))) return c.json({ success: false, message: 'Invalid notification ID' }, 400);

    const deleted = await deleteNotification(execQuery, c.env, tenantId, id);
    if (!deleted) return c.json({ success: false, message: 'Notification not found' }, 404);

    return c.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    return fail(c, error, 'Failed to delete notification');
  }
});

// DELETE / - Hard delete all visible notifications for current user
app.delete('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('user').users_id;
    const deletedCount = await deleteAllNotifications(execQuery, c.env, tenantId, userId);
    return c.json({ success: true, data: { deleted_count: deletedCount } });
  } catch (error) {
    return fail(c, error, 'Failed to delete notifications');
  }
});

export default app;
