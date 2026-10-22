/**
 * Notifications — header bell feed. Thin Hono wrapper over the framework
 * module (@meterit/framework-backend/api/base/notifications) — this file owns
 * only what is TBWC-specific: auth middleware and the response envelope.
 *
 * TBWC is single-tenant (see middleware.ts), so every call passes
 * `{ tenantColumn: null }` and identifies the caller by their Supabase user
 * id (uuid), not a tenant_id. Table public.notification, PK notification_id;
 * see migrations/060-notifications.sql.
 *
 * Reading, acknowledging and clearing your OWN feed needs no role grant — any
 * signed-in user has a bell, and every query below is scoped to c.get('userId').
 * Gating those on notification:read/write/delete meant every custom role made
 * in Settings > Roles 403'd its own bell until someone remembered to tick the
 * boxes (2026-10-22). Grants still gate what reaches OTHER people: sending
 * (notification:write) and deleting a notification that isn't yours
 * (notification:delete).
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, permissionsFor, requirePermission } from '../middleware';
import {
  listNotifications,
  countNotifications,
  createNotification,
  acknowledgeNotification,
  deleteNotification,
  deleteAllNotifications,
  senderDisplayName,
  NotificationValidationError,
  type NotificationsOptions,
} from '@meterit/framework-backend/api/base/notifications';

const OPTIONS: NotificationsOptions = { tenantColumn: null };

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

function fail(c: any, e: unknown) {
  if (e instanceof NotificationValidationError) {
    return c.json({ success: false, message: e.message }, 400);
  }
  console.error('[TBWC notifications]', e);
  return c.json({ success: false, message: 'Notifications request failed' }, 500);
}

app.get('/count', async (c) => {
  try {
    const count = await countNotifications(execQuery, c.env, null, c.get('userId'), OPTIONS);
    return c.json({ success: true, data: { count } });
  } catch (e) {
    return fail(c, e);
  }
});

app.get('/', async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '100') || 100, 200);
    const offset = parseInt(c.req.query('offset') || '0') || 0;

    const { notifications, total } = await listNotifications(
      execQuery, c.env, null, c.get('userId'), { limit, offset }, OPTIONS
    );
    const withId = notifications.map((row) => ({ ...row, id: String(row.notification_id) }));

    return c.json({ success: true, data: { notifications: withId, total, limit, offset } });
  } catch (e) {
    return fail(c, e);
  }
});

app.post('/', requirePermission('notification:write'), async (c) => {
  try {
    const body = await c.req.json();
    const row = await createNotification(execQuery, c.env, null, {
      notificationType: body.notification_type,
      title: body.title,
      severity: body.severity,
      description: body.description,
      usersId: body.users_id,
      linkUrl: body.link_url,
      // Stamp the caller as the sender (same as the AI chat send_notification
      // tool) so a reply has someone to go back to and the bell shows "From".
      createdBy: c.get('userId'),
      createdByName: senderDisplayName(c.get('user')),
    }, OPTIONS);
    return c.json({ success: true, data: { notification: { ...row, id: String(row.notification_id) } } }, 201);
  } catch (e) {
    return fail(c, e);
  }
});

app.post('/:id/acknowledge', async (c) => {
  try {
    const id = c.req.param('id');
    if (isNaN(Number(id))) return c.json({ success: false, message: 'Invalid notification ID' }, 400);

    const row = await acknowledgeNotification(execQuery, c.env, null, id, c.get('userId'), OPTIONS);
    if (!row) return c.json({ success: false, message: 'Notification not found' }, 404);
    return c.json({ success: true, data: { notification: { ...row, id: String(row.notification_id) } } });
  } catch (e) {
    return fail(c, e);
  }
});

app.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (isNaN(Number(id))) return c.json({ success: false, message: 'Invalid notification ID' }, 400);

    // deleteNotification has no owner clause when there's no tenant column, so
    // ownership is checked here: your own goes, anyone else's (or a broadcast,
    // which would vanish for everyone) needs the grant.
    const owner = await execQuery(
      c.env,
      `SELECT users_id FROM public.notification WHERE notification_id = $1`,
      [id],
      'notifications.deleteOwner'
    );
    if (!owner.rows.length) return c.json({ success: false, message: 'Notification not found' }, 404);
    if (owner.rows[0].users_id !== c.get('userId')) {
      const permissions = await permissionsFor(c.env, c.get('user'));
      if (!permissions.has('notification:delete')) {
        return c.json({ success: false, message: 'Insufficient permissions' }, 403);
      }
    }

    const deleted = await deleteNotification(execQuery, c.env, null, id, OPTIONS);
    if (!deleted) return c.json({ success: false, message: 'Notification not found' }, 404);
    return c.json({ success: true, message: 'Notification deleted' });
  } catch (e) {
    return fail(c, e);
  }
});

app.delete('/', async (c) => {
  try {
    const deletedCount = await deleteAllNotifications(execQuery, c.env, null, c.get('userId'), OPTIONS);
    return c.json({ success: true, data: { deleted_count: deletedCount } });
  } catch (e) {
    return fail(c, e);
  }
});

export default app;
