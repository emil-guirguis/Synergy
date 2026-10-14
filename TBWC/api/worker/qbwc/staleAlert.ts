/**
 * Detects a QBWC Web Connector that has stopped contacting the Worker
 * altogether (service stopped, machine off, network down, etc). The Worker
 * only ever writes to qbwc_sync_run in response to an incoming SOAP call, so
 * a dead connector produces zero rows and zero errors — indistinguishable
 * from "nothing to sync" unless something checks the clock from outside.
 * Run from the cron (see index.ts scheduled handler), not from the SOAP
 * endpoint itself.
 *
 * Writes a log row (public.qbwc_sync_run, object_type 'QBWC') every
 * tick the connector is stale, for a continuous record on the sync
 * dashboard. The admin notification + email is separate and throttled: it
 * fires as soon as the connector goes stale, then at most once every
 * ALERT_THROTTLE_HOURS while it stays down (so a weekend outage doesn't page
 * anyone every 15 minutes), going quiet again the moment real sync activity
 * resumes.
 */
import { Env, execQuery } from '../db';
import { logError } from './syncLog';
import { createNotification } from '@meterit/framework-backend/api/base/notifications';
import { sendMail } from '../mail';

// Observed normal cadence is every few minutes while QB Desktop is open;
// generous multiple of that to avoid false positives from a quiet stretch.
const STALE_MINUTES = 30;
const ALERT_THROTTLE_HOURS = 1;

// object_type this module logs its own alert rows under — distinct from
// 'Connection' (used by qbwc.ts for real auth/connectionError failures) so
// an alert row never gets mistaken for genuine connector activity when
// checking how long it's actually been since QBWC last talked to us.
const ALERT_OBJECT_TYPE = 'QBWC';

// Who gets paged. Not role.code = 'admin' — permissions.ts is explicit that
// nothing branches on a role's name, since roles are user-creatable and a
// name check silently excludes every role made after it. qbsync:run is the
// permission that gates the reload button on this same dashboard (migration
// 039 grants it to Admin only today, same convention supportNotify.ts uses
// for support:write), so "can act on this" is exactly who should hear about
// it, and any future role granted that permission is included automatically.
const ADMIN_PERMISSION = 'qbsync:run';

async function adminRecipients(env: Env): Promise<{ id: string; email: string; first_name: string | null }[]> {
  const { rows } = await execQuery(
    env,
    `SELECT DISTINCT u.id, u.email, u.first_name
       FROM public.users u
       JOIN public.role_permission rp ON rp.role_id = u.role_id
      WHERE rp.permission = $1 AND u.email IS NOT NULL`,
    [ADMIN_PERMISSION],
    'qbwc.staleAlert.admins'
  );
  return rows;
}

export async function checkQbwcStale(env: Env): Promise<void> {
  const r = await execQuery(
    env,
    `SELECT
       (SELECT MAX(created_at) FROM public.qbwc_sync_run WHERE object_type <> $1) AS last_activity,
       (SELECT MAX(created_at) FROM public.qbwc_sync_run
          WHERE object_type = $1 AND detail = 'notified') AS last_notified`,
    [ALERT_OBJECT_TYPE],
    'qbwc.staleAlert.check'
  );
  const row = r.rows[0];
  const lastActivity: Date | null = row?.last_activity ? new Date(row.last_activity) : null;
  if (!lastActivity) return; // no sync activity ever logged — nothing to compare against yet

  const now = Date.now();
  const minutesSinceActivity = (now - lastActivity.getTime()) / 60_000;
  if (minutesSinceActivity < STALE_MINUTES) return; // healthy — nothing to log

  // A notification already sent during THIS outage (after the last real
  // contact) throttles further notifications for ALERT_THROTTLE_HOURS. One
  // from a prior, since-recovered outage is older than lastActivity and is
  // ignored here, so a fresh outage always notifies immediately. The log
  // row below is written every stale tick regardless — only the notify/email
  // step is gated on this.
  const lastNotified: Date | null = row?.last_notified ? new Date(row.last_notified) : null;
  const throttled = !!(
    lastNotified && lastNotified > lastActivity &&
    (now - lastNotified.getTime()) / 3_600_000 < ALERT_THROTTLE_HOURS
  );

  const message = `No QBWC activity in ${Math.floor(minutesSinceActivity)} min — Web Connector appears disconnected or not running.`;
  await logError(env, null, ALERT_OBJECT_TYPE, message, throttled ? null : 'notified');
  if (throttled) return;

  const admins = await adminRecipients(env);
  for (const admin of admins) {
    try {
      await createNotification(execQuery, env, null, {
        notificationType: 'qbwc_connection',
        severity: 'error',
        title: 'QuickBooks sync disconnected',
        description: message,
        usersId: admin.id,
        linkUrl: '/qb-sync',
      }, { tenantColumn: null });
    } catch (e) {
      console.error('[QBWC] stale-alert notification failed for', admin.id, e);
    }

    try {
      await sendMail(env, {
        type: 'document',
        email: admin.email,
        subject: 'QuickBooks sync disconnected',
        bodyHtml:
          `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b4e57;">Hi ${admin.first_name || 'there'},</p>` +
          `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b4e57;">${message}</p>` +
          `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b4e57;">Check the QuickBooks Web Connector app and QB Desktop machine — this alert repeats at most once every ${ALERT_THROTTLE_HOURS}h until sync resumes.</p>`,
      });
    } catch (e) {
      console.error('[QBWC] stale-alert email failed for', admin.email, e instanceof Error ? e.message : e);
    }
  }
}
