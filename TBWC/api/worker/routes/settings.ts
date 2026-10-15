/**
 * Company settings — org info + system config shown on the Settings page.
 * Singleton table (one row); admin-only, same as customers/inventory.
 * Row<->shape mapping lives in the framework base module so it stays
 * identical to MeterItPro's settings shape — see
 * framework/backend/api/base/settings.ts.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { rowToBasicSettings, basicSettingsToRow } from '@meterit/framework-backend/api/base/settings';
import { latestRunPerJob, recentRuns, avgDurationPerJob } from '../cronMonitor';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authenticateToken);

const TABLE = 'company_settings';
const PK = 'company_settings_id';

async function loadRow(env: Env) {
  const result = await execQuery(
    env,
    `SELECT * FROM public.${TABLE} ORDER BY ${PK} LIMIT 1`,
    [],
    'settings.load'
  );
  return result.rows[0] ?? null;
}

app.get('/', requirePermission('setting:read'), async (c) => {
  const row = await loadRow(c.env);
  if (!row) return c.json({ success: false, message: 'Settings not found' }, 404);
  return c.json({ success: true, data: rowToBasicSettings(row) });
});

app.put('/', requirePermission('setting:write'), async (c) => {
  const existing = await loadRow(c.env);
  if (!existing) return c.json({ success: false, message: 'Settings not found' }, 404);

  const body = await c.req.json();
  const updateData = basicSettingsToRow(body);
  if (Object.keys(updateData).length === 0) {
    return c.json({ success: true, data: rowToBasicSettings(existing) });
  }

  const setClause: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(updateData)) {
    setClause.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  setClause.push('updated_at = NOW()');
  values.push(existing[PK]);

  const result = await execQuery(
    c.env,
    `UPDATE public.${TABLE} SET ${setClause.join(', ')} WHERE ${PK} = $${idx} RETURNING *`,
    values,
    'settings.update'
  );

  return c.json({
    success: true,
    data: rowToBasicSettings(result.rows[0]),
    message: 'Settings updated successfully',
  });
});

// --- Scheduled Jobs tab: worker/cronMonitor.ts's cron_run_log + alert_setting
// (migration 102) — see worker/qbwc/staleAlert.ts for the one check reading
// alert_setting today. ---------------------------------------------------

app.get('/cron-log', requirePermission('setting:read'), async (c) => {
  const [latest, recent, avg] = await Promise.all([
    latestRunPerJob(c.env),
    recentRuns(c.env, 100),
    avgDurationPerJob(c.env, 24),
  ]);
  return c.json({ success: true, data: { latest, recent, avg } });
});

app.get('/alerts', requirePermission('setting:read'), async (c) => {
  const result = await execQuery(
    c.env,
    `SELECT alert_setting_id, alert_key, enabled, notify_email, notify_inapp, threshold_minutes,
            throttle_hours, recipient_permission, recipient_user_ids, updated_at
       FROM public.alert_setting
      ORDER BY alert_key`,
    [],
    'settings.alerts.list'
  );
  return c.json({ success: true, data: result.rows });
});

const ALERT_SETTING_COLUMNS = [
  'enabled', 'notify_email', 'notify_inapp', 'threshold_minutes',
  'throttle_hours', 'recipient_permission', 'recipient_user_ids',
];

app.put('/alerts/:alertKey', requirePermission('setting:write'), async (c) => {
  const alertKey = c.req.param('alertKey');
  const body = await c.req.json();
  const updateData: Record<string, any> = {};
  for (const col of ALERT_SETTING_COLUMNS) {
    if (col in body) updateData[col] = body[col];
  }
  if (Object.keys(updateData).length === 0) {
    return c.json({ success: false, message: 'No recognized fields in request body' }, 400);
  }

  const setClause: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(updateData)) {
    setClause.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  setClause.push('updated_at = NOW()');
  values.push(alertKey);

  const result = await execQuery(
    c.env,
    `UPDATE public.alert_setting SET ${setClause.join(', ')} WHERE alert_key = $${idx} RETURNING *`,
    values,
    'settings.alerts.update'
  );
  if (!result.rows[0]) return c.json({ success: false, message: `No alert_setting row for "${alertKey}"` }, 404);
  return c.json({ success: true, data: result.rows[0], message: 'Alert setting updated' });
});

export default app;
