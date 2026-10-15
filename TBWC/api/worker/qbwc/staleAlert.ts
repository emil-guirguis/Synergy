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

// Row key in public.alert_setting (migration 102) — Settings > Scheduled Jobs
// edits this row. Values below are the fallback if that row (or the table
// itself, pre-migration) is missing, so a bad/absent settings row degrades to
// today's hardcoded behavior rather than silently disabling the alert.
const ALERT_KEY = 'qbwc_stale';
// Observed normal cadence is every few minutes while QB Desktop is open;
// generous multiple of that to avoid false positives from a quiet stretch.
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_THROTTLE_HOURS = 1;
// Not role.code = 'admin' — permissions.ts is explicit that nothing branches
// on a role's name, since roles are user-creatable and a name check silently
// excludes every role made after it. qbsync:run is the permission that gates
// the reload button on this same dashboard (migration 039 grants it to Admin
// only today, same convention supportNotify.ts uses for support:write).
const DEFAULT_RECIPIENT_PERMISSION = 'qbsync:run';

// object_type this module logs its own alert rows under — distinct from
// 'Connection' (used by qbwc.ts for real auth/connectionError failures) so
// an alert row never gets mistaken for genuine connector activity when
// checking how long it's actually been since QBWC last talked to us.
const ALERT_OBJECT_TYPE = 'QBWC';

interface AlertSetting {
  enabled: boolean;
  notifyEmail: boolean;
  notifyInapp: boolean;
  thresholdMinutes: number;
  throttleHours: number;
  recipientPermission: string;
  recipientUserIds: string[];
}

const DEFAULT_SETTING: AlertSetting = {
  enabled: true,
  notifyEmail: true,
  notifyInapp: true,
  thresholdMinutes: DEFAULT_STALE_MINUTES,
  throttleHours: DEFAULT_THROTTLE_HOURS,
  recipientPermission: DEFAULT_RECIPIENT_PERMISSION,
  recipientUserIds: [],
};

async function loadAlertSetting(env: Env, alertKey: string): Promise<AlertSetting> {
  try {
    const { rows } = await execQuery(
      env,
      `SELECT enabled, notify_email, notify_inapp, threshold_minutes, throttle_hours,
              recipient_permission, recipient_user_ids
         FROM public.alert_setting
        WHERE alert_key = $1`,
      [alertKey],
      'qbwc.staleAlert.settings'
    );
    const row = rows[0];
    if (!row) return DEFAULT_SETTING;
    return {
      enabled: row.enabled ?? DEFAULT_SETTING.enabled,
      notifyEmail: row.notify_email ?? DEFAULT_SETTING.notifyEmail,
      notifyInapp: row.notify_inapp ?? DEFAULT_SETTING.notifyInapp,
      thresholdMinutes: row.threshold_minutes ?? DEFAULT_SETTING.thresholdMinutes,
      throttleHours: row.throttle_hours != null ? Number(row.throttle_hours) : DEFAULT_SETTING.throttleHours,
      recipientPermission: row.recipient_permission ?? DEFAULT_SETTING.recipientPermission,
      recipientUserIds: row.recipient_user_ids ?? [],
    };
  } catch (e) {
    // Table/row missing (migration 102 not applied yet) must not disable the
    // alert — fall back to the hardcoded defaults it replaced.
    console.error('[QBWC] alert_setting load failed, using built-in defaults:', e instanceof Error ? e.message : e);
    return DEFAULT_SETTING;
  }
}

// Permission-based recipients, plus whatever alert_setting.recipient_user_ids
// adds on top (not instead of) — an explicit admin can always be included
// regardless of their role's permission grants.
async function adminRecipients(
  env: Env,
  permission: string,
  extraUserIds: string[]
): Promise<{ id: string; email: string; first_name: string | null }[]> {
  const { rows } = await execQuery(
    env,
    `SELECT DISTINCT u.id, u.email, u.first_name
       FROM public.users u
       LEFT JOIN public.role_permission rp ON rp.role_id = u.role_id AND rp.permission = $1
      WHERE u.email IS NOT NULL
        AND (rp.permission IS NOT NULL OR u.id = ANY($2::uuid[]))`,
    [permission, extraUserIds],
    'qbwc.staleAlert.admins'
  );
  return rows;
}

export async function checkQbwcStale(env: Env): Promise<void> {
  const setting = await loadAlertSetting(env, ALERT_KEY);
  if (!setting.enabled) return; // turned off in Settings > Scheduled Jobs

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
  if (minutesSinceActivity < setting.thresholdMinutes) return; // healthy — nothing to log

  // A notification already sent during THIS outage (after the last real
  // contact) throttles further notifications for setting.throttleHours. One
  // from a prior, since-recovered outage is older than lastActivity and is
  // ignored here, so a fresh outage always notifies immediately. The log
  // row below is written every stale tick regardless — only the notify/email
  // step is gated on this.
  const lastNotified: Date | null = row?.last_notified ? new Date(row.last_notified) : null;
  const throttled = !!(
    lastNotified && lastNotified > lastActivity &&
    (now - lastNotified.getTime()) / 3_600_000 < setting.throttleHours
  );

  const message = `No QBWC activity in ${Math.floor(minutesSinceActivity)} min — Web Connector appears disconnected or not running.`;
  await logError(env, null, ALERT_OBJECT_TYPE, message, throttled ? null : 'notified');
  if (throttled) return;

  // Settled in parallel, not sequentially: 6 admins x (DB insert + outbound
  // fetch) run one after another otherwise, and a scheduled Worker invocation
  // has a wall-clock budget — a slow run risks later admins never being
  // attempted at all, with nothing to show for it since each failure was
  // only ever console.error'd (invisible outside `wrangler tail`).
  const admins = await adminRecipients(env, setting.recipientPermission, setting.recipientUserIds);
  if (admins.length === 0) {
    // Not a throw: the function must still return normally so the 'notified'
    // row above stands and the next tick's throttle window is honored. Without
    // this, nobody holding the configured permission (role drift, bad role_id)
    // looks identical on the dashboard to "notified everyone successfully".
    await logError(env, null, ALERT_OBJECT_TYPE, `no recipients — nobody holds ${setting.recipientPermission}`, 'no admins');
    return;
  }
  await Promise.allSettled(admins.map(async (admin) => {
    if (setting.notifyInapp) {
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
        await logError(env, null, ALERT_OBJECT_TYPE, `notify failed for ${admin.email}`, e instanceof Error ? e.message : String(e));
      }
    }

    if (setting.notifyEmail) {
      try {
        await sendMail(env, {
          type: 'document',
          email: admin.email,
          subject: 'QuickBooks sync disconnected',
          bodyHtml:
            `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b4e57;">Hi ${admin.first_name || 'there'},</p>` +
            `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b4e57;">${message}</p>` +
            `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b4e57;">Check the QuickBooks Web Connector app and QB Desktop machine — this alert repeats at most once every ${setting.throttleHours}h until sync resumes.</p>`,
        });
      } catch (e) {
        await logError(env, null, ALERT_OBJECT_TYPE, `email failed for ${admin.email}`, e instanceof Error ? e.message : String(e));
      }
    }
  }));
}
