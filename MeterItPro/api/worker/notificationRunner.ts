/**
 * Notification rule execution for Cloudflare Workers.
 *
 * Rules are thin consumers of quality-engine state (meter_reading_gap,
 * meter_element_watermark — see qualityEngine.ts): one set-based query per
 * rule type instead of per-meter-element scans.
 *
 * Alert lifecycle (migration 046):
 *   open -> acknowledged (user) -> cleared (row deleted when condition ends)
 * Emails send only when an alert newly opens or the re-notify window lapses,
 * gated by the rule's cron schedule — not on every matching tick.
 *
 * Email is sent via Resend (same as reportRunner). DB access via execQuery().
 */

import { Env, execQuery } from './db';
import { matchesCronSchedule } from './cronMatcher';

// Re-notify cadence for still-open, unacknowledged alerts.
const RENOTIFY_HOURS = 24;

// --- Types --------------------------------------------------------------------

interface NotificationRule {
  notification_rule_id: string;
  tenant_id: string;
  name: string;
  rule_type: string;
  threshold_hours: number | null;
  demand_threshold: number | null;
  schedule_cron: string;
  meter_selections: any;
}

interface MeterSelection {
  id: string;
  meter_id: number | null;
  meter_element_ids: number[] | null;
  register_field_names: string[];
}

interface MeterElementPair {
  meter_id: string;
  meter_element_id: string;
  display_name: string;
}

interface Violation {
  meter_id: string;
  meter_element_id: string;
  severity: string;
  title: string;
  description: string;
  emailSubject: string;
  emailBody: string;
  headerColor: string;
  headerTitle: string;
}

// --- Helpers ------------------------------------------------------------------

function parseMeterSelections(raw: any): MeterSelection[] | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  if (Array.isArray(raw)) return raw as MeterSelection[];
  return null;
}

async function getRuleMeterElements(env: Env, rule: NotificationRule): Promise<MeterElementPair[]> {
  const selections = parseMeterSelections(rule.meter_selections);
  let pairs: Array<{ meter_id: string; meter_element_id: string }> = [];

  if (selections && selections.length > 0) {
    const explicitPairs: Array<{ meter_id: string; meter_element_id: string }> = [];
    const meterIdsNeedingFetch: string[] = [];

    for (const sel of selections) {
      if (!sel.meter_id) continue;
      const meterId = String(sel.meter_id);
      if (sel.meter_element_ids && sel.meter_element_ids.length > 0) {
        for (const elId of sel.meter_element_ids) {
          explicitPairs.push({ meter_id: meterId, meter_element_id: String(elId) });
        }
      } else {
        meterIdsNeedingFetch.push(meterId);
      }
    }

    pairs = explicitPairs;

    if (meterIdsNeedingFetch.length > 0) {
      const placeholders = meterIdsNeedingFetch.map((_, i) => `$${i + 1}`).join(', ');
      const fetched = await execQuery(
        env,
        `SELECT meter_id, meter_element_id FROM meter_element WHERE meter_id IN (${placeholders})`,
        meterIdsNeedingFetch
      );
      for (const row of fetched.rows) {
        pairs.push({ meter_id: String(row.meter_id), meter_element_id: String(row.meter_element_id) });
      }
    }
  } else {
    const all = await execQuery(
      env,
      `SELECT m.meter_id, me.meter_element_id
       FROM meter m
       JOIN meter_element me ON me.meter_id = m.meter_id
       WHERE m.tenant_id = $1 AND m.active = true`,
      [rule.tenant_id]
    );
    pairs = all.rows;
  }

  if (pairs.length === 0) return [];

  // Fetch display names in one query
  const placeholders = pairs.map((_, i) => `($${i * 2 + 1}::bigint, $${i * 2 + 2}::bigint)`).join(', ');
  const flatParams = pairs.flatMap(p => [p.meter_id, p.meter_element_id]);

  const nameResult = await execQuery(
    env,
    `SELECT m.meter_id, me.meter_element_id,
       CONCAT(COALESCE(m.name,'Unknown'),'    ',COALESCE(TRIM(me.element),'?'),'-',COALESCE(me.name,'Unknown')) AS display_name
     FROM (VALUES ${placeholders}) AS v(mid, meid)
     JOIN meter m ON m.meter_id = v.mid
     JOIN meter_element me ON me.meter_element_id = v.meid`,
    flatParams
  );

  return nameResult.rows.map(r => ({
    meter_id: String(r.meter_id),
    meter_element_id: String(r.meter_element_id),
    display_name: r.display_name,
  }));
}

async function getEmailRecipients(env: Env, ruleId: string): Promise<string[]> {
  const result = await execQuery(
    env,
    `SELECT email_address FROM notification_rule_recipient WHERE notification_rule_id = $1`,
    [ruleId]
  );
  return result.rows.map(r => r.email_address).filter((e): e is string => !!e);
}

/**
 * Build a `(VALUES ...) AS v(mid, meid)` join clause for a pair list.
 * Returns the SQL fragment and params, with placeholders starting at `startAt`.
 */
function pairValuesClause(
  pairs: Array<{ meter_id: string; meter_element_id: string }>,
  startAt: number
): { clause: string; params: string[] } {
  const clause = pairs
    .map((_, i) => `($${startAt + i * 2}::bigint, $${startAt + i * 2 + 1}::bigint)`)
    .join(', ');
  return { clause, params: pairs.flatMap(p => [p.meter_id, p.meter_element_id]) };
}

// --- Email via Resend ---------------------------------------------------------

async function sendEmail(env: Env, recipients: string[], subject: string, html: string): Promise<void> {
  const apiKey = (env as any).RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[notificationRunner] RESEND_API_KEY not set - skipping email');
    return;
  }
  const from = (env as any).RESEND_FROM || 'MeterItPro <noreply@meteritpro.com>';

  await Promise.all(recipients.map(async (to) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[notificationRunner] Resend error for ${to} (${res.status}): ${err}`);
    }
  }));
}

function buildEmailHtml(opts: {
  headerColor: string;
  headerTitle: string;
  headerSubtitle: string;
  body: string;
  ruleName: string;
}): string {
  return `<!DOCTYPE html>
<html>
<head><style>
  body{font-family:Arial,sans-serif;color:#333;margin:0;padding:0}
  .hdr{background:${opts.headerColor};color:#fff;padding:16px 20px}
  .hdr h2{margin:0 0 4px;font-size:18px}
  .hdr p{margin:0;font-size:13px;opacity:.85}
  .body{padding:20px;line-height:1.6}
  .foot{border-top:1px solid #eee;padding:12px 20px;font-size:11px;color:#999}
</style></head>
<body>
  <div class="hdr"><h2>${opts.headerTitle}</h2><p>${opts.headerSubtitle}</p></div>
  <div class="body">${opts.body}</div>
  <div class="foot">Automated alert from MeterItPro - Rule: ${opts.ruleName}</div>
</body>
</html>`;
}

// --- Alert lifecycle ----------------------------------------------------------

/**
 * Reconcile violations against notification rows for one rule/type:
 *  - delete rows for pairs no longer violating (condition cleared)
 *  - upsert rows for violating pairs (preserving status/last_notified_at)
 *  - when shouldFire, email newly-opened or renotify-due alerts and stamp
 *    last_notified_at
 */
async function applyViolations(
  env: Env,
  rule: NotificationRule,
  notificationType: string,
  allPairs: MeterElementPair[],
  violations: Violation[],
  shouldFire: boolean
): Promise<void> {
  if (allPairs.length === 0) return;

  // 1. Clear pairs that are no longer violating.
  const violatingKeys = new Set(violations.map(v => `${v.meter_id}:${v.meter_element_id}`));
  const clearedPairs = allPairs.filter(p => !violatingKeys.has(`${p.meter_id}:${p.meter_element_id}`));
  if (clearedPairs.length > 0) {
    const { clause, params } = pairValuesClause(clearedPairs, 3);
    await execQuery(env,
      `DELETE FROM notification n
       USING (VALUES ${clause}) AS v(mid, meid)
       WHERE n.tenant_id = $1 AND n.notification_type = $2
         AND n.meter_id = v.mid AND n.meter_element_id = v.meid`,
      [rule.tenant_id, notificationType, ...params]
    );
  }

  if (violations.length === 0) return;

  // 2. Snapshot existing alert state before upserting (for email dedup).
  const { clause: vClause, params: vParams } = pairValuesClause(violations, 3);
  const existing = await execQuery(env,
    `SELECT n.meter_id, n.meter_element_id, n.status, n.last_notified_at
     FROM notification n
     JOIN (VALUES ${vClause}) AS v(mid, meid)
       ON n.meter_id = v.mid AND n.meter_element_id = v.meid
     WHERE n.tenant_id = $1 AND n.notification_type = $2`,
    [rule.tenant_id, notificationType, ...vParams]
  );
  const existingByKey = new Map<string, { status: string; last_notified_at: Date | null }>();
  for (const row of existing.rows) {
    existingByKey.set(`${row.meter_id}:${row.meter_element_id}`, {
      status: row.status,
      last_notified_at: row.last_notified_at ? new Date(row.last_notified_at) : null,
    });
  }

  // 3. Upsert all violations in one statement. Status and notify timestamps
  //    survive the upsert so ack state and dedup are preserved.
  const upsertValues = violations
    .map((_, i) => {
      const b = 2 + i * 5;
      return `($1, $${b}::bigint, $${b + 1}::bigint, '${notificationType}', $${b + 2}, $${b + 3}, $${b + 4})`;
    })
    .join(', ');
  const upsertParams = [
    rule.tenant_id,
    ...violations.flatMap(v => [v.meter_id, v.meter_element_id, v.severity, v.title, v.description]),
  ];
  await execQuery(env,
    `INSERT INTO notification (tenant_id, meter_id, meter_element_id, notification_type, severity, title, description)
     VALUES ${upsertValues}
     ON CONFLICT ON CONSTRAINT notification_unique_target
     DO UPDATE SET
       severity    = EXCLUDED.severity,
       title       = EXCLUDED.title,
       description = EXCLUDED.description,
       created_at  = CURRENT_TIMESTAMP`,
    upsertParams
  );

  // 4. Emails — only on the rule's cron cadence, and only for alerts that are
  //    newly opened or past the re-notify window. Acknowledged alerts stay quiet.
  if (!shouldFire) return;

  const renotifyCutoff = Date.now() - RENOTIFY_HOURS * 3_600_000;
  const due = violations.filter(v => {
    const prior = existingByKey.get(`${v.meter_id}:${v.meter_element_id}`);
    if (!prior) return true; // newly opened
    if (prior.status === 'acknowledged') return false;
    return !prior.last_notified_at || prior.last_notified_at.getTime() < renotifyCutoff;
  });
  if (due.length === 0) return;

  const recipients = await getEmailRecipients(env, rule.notification_rule_id);
  if (recipients.length > 0) {
    await Promise.all(due.map(v =>
      sendEmail(env, recipients, v.emailSubject, buildEmailHtml({
        headerColor: v.headerColor,
        headerTitle: v.headerTitle,
        headerSubtitle: `${rule.name} - ${v.title}`,
        body: v.emailBody,
        ruleName: rule.name,
      }))
    ));
  }

  const { clause: dueClause, params: dueParams } = pairValuesClause(due, 3);
  await execQuery(env,
    `UPDATE notification n
     SET last_notified_at = NOW()
     FROM (VALUES ${dueClause}) AS v(mid, meid)
     WHERE n.tenant_id = $1 AND n.notification_type = $2
       AND n.meter_id = v.mid AND n.meter_element_id = v.meid`,
    [rule.tenant_id, notificationType, ...dueParams]
  );
}

// --- Rule type: meter_no_reading ----------------------------------------------

async function checkMeterNoReading(env: Env, rule: NotificationRule, shouldFire: boolean): Promise<void> {
  const thresholdHours = rule.threshold_hours ?? 24;
  const pairs = await getRuleMeterElements(env, rule);
  if (pairs.length === 0) return;
  const byKey = new Map(pairs.map(p => [`${p.meter_id}:${p.meter_element_id}`, p]));

  const { clause, params } = pairValuesClause(pairs, 3);

  // Silent / never-reported elements — from watermarks, no reading scan.
  const silent = await execQuery(env,
    `SELECT w.meter_id, w.meter_element_id, w.last_reading_at
     FROM meter_element_watermark w
     JOIN (VALUES ${clause}) AS v(mid, meid)
       ON w.meter_id = v.mid AND w.meter_element_id = v.meid
     WHERE w.tenant_id = $1
       AND (w.last_reading_at IS NULL
            OR w.last_reading_at < NOW() - ($2 || ' hours')::interval)`,
    [rule.tenant_id, thresholdHours, ...params]
  );

  // Open gaps touching the threshold window — worst gap per element.
  const gaps = await execQuery(env,
    `SELECT DISTINCT ON (g.meter_id, g.meter_element_id)
       g.meter_id, g.meter_element_id,
       g.gap_start,
       COALESCE(g.gap_end, NOW()) AS gap_end,
       ROUND(EXTRACT(EPOCH FROM (COALESCE(g.gap_end, NOW()) - g.gap_start)) / 60) AS gap_minutes,
       COUNT(*) OVER (PARTITION BY g.meter_id, g.meter_element_id) AS total_gaps
     FROM meter_reading_gap g
     JOIN (VALUES ${clause}) AS v(mid, meid)
       ON g.meter_id = v.mid AND g.meter_element_id = v.meid
     WHERE g.tenant_id = $1 AND g.status = 'open'
       AND COALESCE(g.gap_end, NOW()) >= NOW() - ($2 || ' hours')::interval
     ORDER BY g.meter_id, g.meter_element_id,
              (COALESCE(g.gap_end, NOW()) - g.gap_start) DESC`,
    [rule.tenant_id, thresholdHours, ...params]
  );

  const violations: Violation[] = [];
  const silentKeys = new Set<string>();

  for (const row of silent.rows) {
    const key = `${row.meter_id}:${row.meter_element_id}`;
    const pair = byKey.get(key);
    if (!pair) continue;
    silentKeys.add(key);

    const lastReadingAt = row.last_reading_at ? new Date(row.last_reading_at) : null;
    const hoursSince = lastReadingAt
      ? Math.round((Date.now() - lastReadingAt.getTime()) / 3_600_000)
      : null;
    violations.push({
      meter_id: pair.meter_id,
      meter_element_id: pair.meter_element_id,
      severity: 'error',
      title: `${pair.display_name} - No readings for ${hoursSince ?? '?'} hours`,
      description: lastReadingAt
        ? `Last reading was ${hoursSince} hours ago (${lastReadingAt.toLocaleString()}), exceeding the ${thresholdHours}h threshold.`
        : `No readings have ever been recorded for this meter element.`,
      emailSubject: `Alert: ${pair.display_name} - No readings for ${hoursSince ?? '?'}h`,
      emailBody: `<p><strong>${pair.display_name}</strong> has not sent any readings for
                  <strong>${hoursSince ?? 'an unknown number of'} hours</strong>,
                  exceeding the configured threshold of
                  <strong>${thresholdHours} hour${thresholdHours !== 1 ? 's' : ''}</strong>.</p>
                  ${lastReadingAt ? `<p><strong>Last reading:</strong> ${lastReadingAt.toLocaleString()}</p>` : ''}
                  <p>Please check the meter connection and BACnet configuration.</p>`,
      headerColor: '#c62828',
      headerTitle: 'Missing Meter Readings Alert',
    });
  }

  for (const row of gaps.rows) {
    const key = `${row.meter_id}:${row.meter_element_id}`;
    if (silentKeys.has(key)) continue; // silence alert already covers it
    const pair = byKey.get(key);
    if (!pair) continue;

    const totalGaps = parseInt(row.total_gaps, 10);
    const gapMinutes = Math.round(parseFloat(row.gap_minutes));
    const gapHours = Math.round((gapMinutes / 60) * 10) / 10;
    const gapStart = new Date(row.gap_start);
    const gapEnd = new Date(row.gap_end);

    violations.push({
      meter_id: pair.meter_id,
      meter_element_id: pair.meter_element_id,
      severity: 'error',
      title: `${pair.display_name} - ${totalGaps} reading gap${totalGaps !== 1 ? 's' : ''} detected`,
      description: `Largest gap: ${gapMinutes} min (${gapStart.toLocaleString()} - ${gapEnd.toLocaleString()}). `
        + `${totalGaps} gap${totalGaps !== 1 ? 's' : ''} found in the last ${thresholdHours}h window.`,
      emailSubject: `Alert: ${pair.display_name} - ${gapHours}h gap in readings`,
      emailBody: `<p>A gap of <strong>${gapHours} hours</strong> was detected for <strong>${pair.display_name}</strong>
                  within the last ${thresholdHours}-hour monitoring window.</p>
                  <p><strong>Gap period:</strong> ${gapStart.toLocaleString()} &mdash; ${gapEnd.toLocaleString()}</p>
                  <p>Please check the meter connection and BACnet configuration.</p>`,
      headerColor: '#c62828',
      headerTitle: 'Missing Meter Readings Alert',
    });
  }

  await applyViolations(env, rule, 'meter_no_reading', pairs, violations, shouldFire);
}

// --- Rule type: meter_zero_reading --------------------------------------------

async function checkMeterZeroReading(env: Env, rule: NotificationRule, shouldFire: boolean): Promise<void> {
  const thresholdHours = rule.threshold_hours ?? 24;
  const pairs = await getRuleMeterElements(env, rule);
  if (pairs.length === 0) return;
  const byKey = new Map(pairs.map(p => [`${p.meter_id}:${p.meter_element_id}`, p]));

  const { clause, params } = pairValuesClause(pairs, 3);
  const result = await execQuery(env,
    `SELECT r.meter_id, r.meter_element_id,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE r.kwh = 0 AND r.kw = 0) AS zero_count
     FROM meter_reading r
     JOIN (VALUES ${clause}) AS v(mid, meid)
       ON r.meter_id = v.mid AND r.meter_element_id = v.meid
     WHERE r.tenant_id = $1
       AND r.created_at >= NOW() - ($2 || ' hours')::interval
     GROUP BY r.meter_id, r.meter_element_id`,
    [rule.tenant_id, thresholdHours, ...params]
  );

  const violations: Violation[] = [];
  for (const row of result.rows) {
    const total = parseInt(row.total, 10);
    const zeroCount = parseInt(row.zero_count, 10);
    if (!(total > 0 && total === zeroCount)) continue;
    const pair = byKey.get(`${row.meter_id}:${row.meter_element_id}`);
    if (!pair) continue;

    violations.push({
      meter_id: pair.meter_id,
      meter_element_id: pair.meter_element_id,
      severity: 'warning',
      title: `${pair.display_name} - ${total} reading${total !== 1 ? 's' : ''} all zero`,
      description: `All ${total} reading${total !== 1 ? 's' : ''} in the last ${thresholdHours} hours show kWh=0 and kW=0.`,
      emailSubject: `Alert: ${pair.display_name} - All ${total} readings are zero`,
      emailBody: `<p><strong>${pair.display_name}</strong> has sent <strong>${total} reading${total !== 1 ? 's' : ''}</strong>
                  in the last <strong>${thresholdHours} hour${thresholdHours !== 1 ? 's' : ''}</strong>,
                  but every reading shows <strong>kWh = 0</strong> and <strong>kW = 0</strong>.</p>
                  <p>The meter is communicating but reporting no energy consumption.
                  This may indicate a wiring issue, CT clamp problem, or meter configuration error.</p>`,
      headerColor: '#e65100',
      headerTitle: 'Zero Energy Readings Alert',
    });
  }

  await applyViolations(env, rule, 'meter_zero_reading', pairs, violations, shouldFire);
}

// --- Rule type: demand_threshold ---------------------------------------------

async function checkDemandThreshold(env: Env, rule: NotificationRule, shouldFire: boolean): Promise<void> {
  if (!rule.demand_threshold) return;
  const thresholdHours = rule.threshold_hours ?? 1;
  const pairs = await getRuleMeterElements(env, rule);
  if (pairs.length === 0) return;
  const byKey = new Map(pairs.map(p => [`${p.meter_id}:${p.meter_element_id}`, p]));

  const { clause, params } = pairValuesClause(pairs, 4);
  const result = await execQuery(env,
    `SELECT DISTINCT ON (r.meter_id, r.meter_element_id)
       r.meter_id, r.meter_element_id, r.kw, r.created_at
     FROM meter_reading r
     JOIN (VALUES ${clause}) AS v(mid, meid)
       ON r.meter_id = v.mid AND r.meter_element_id = v.meid
     WHERE r.tenant_id = $1
       AND r.created_at >= NOW() - ($2 || ' hours')::interval
       AND r.kw > $3
     ORDER BY r.meter_id, r.meter_element_id, r.kw DESC`,
    [rule.tenant_id, thresholdHours, rule.demand_threshold, ...params]
  );

  const violations: Violation[] = [];
  const threshold = Number(rule.demand_threshold);
  for (const row of result.rows) {
    const pair = byKey.get(`${row.meter_id}:${row.meter_element_id}`);
    if (!pair) continue;
    const peakKw = Number(row.kw);
    const peakAt = new Date(row.created_at);
    const overBy = (peakKw - threshold).toFixed(1);

    violations.push({
      meter_id: pair.meter_id,
      meter_element_id: pair.meter_element_id,
      severity: 'error',
      title: `${pair.display_name} - Peak demand ${peakKw.toFixed(1)} kW exceeds ${threshold} kW`,
      description: `Peak demand of ${peakKw.toFixed(1)} kW at ${peakAt.toISOString()}, exceeding threshold of ${threshold} kW.`,
      emailSubject: `Alert: ${pair.display_name} - Peak demand ${peakKw.toFixed(1)} kW exceeds ${threshold} kW`,
      emailBody: `<p><strong>${pair.display_name}</strong> reached a peak demand of
                  <strong>${peakKw.toFixed(1)} kW</strong> at ${peakAt.toLocaleString()},
                  exceeding the configured threshold of <strong>${threshold} kW</strong>
                  by <strong>${overBy} kW</strong>.</p>
                  <p>Review load scheduling or consider increasing demand capacity.</p>`,
      headerColor: '#1565c0',
      headerTitle: 'Demand Threshold Exceeded',
    });
  }

  await applyViolations(env, rule, 'demand_threshold', pairs, violations, shouldFire);
}

// --- Public API ---------------------------------------------------------------

export async function runNotificationRule(env: Env, ruleId: string): Promise<void> {
  const result = await execQuery(env,
    `SELECT notification_rule_id, tenant_id, name, rule_type,
            threshold_hours, demand_threshold, schedule_cron, meter_selections
     FROM notification_rule WHERE notification_rule_id = $1 AND active = true`,
    [ruleId]
  );
  if (result.rows.length === 0) throw new Error(`Notification rule ${ruleId} not found or inactive`);
  await executeRule(env, result.rows[0], true);
}

export async function runAllActiveNotificationRules(env: Env, now: Date = new Date()): Promise<void> {
  const result = await execQuery(env,
    `SELECT notification_rule_id, tenant_id, name, rule_type,
            threshold_hours, demand_threshold, schedule_cron, meter_selections
     FROM notification_rule WHERE active = true`
  );

  await Promise.all(result.rows.map(async (rule) => {
    const shouldFire = matchesCronSchedule(rule.schedule_cron, now);
    try {
      await executeRule(env, rule, shouldFire);
    } catch (err) {
      console.error(`[cron] Notification rule ${rule.notification_rule_id} failed:`, err instanceof Error ? err.message : err);
    }
  }));
}

async function executeRule(env: Env, rule: NotificationRule, shouldFire: boolean): Promise<void> {
  switch (rule.rule_type) {
    case 'meter_no_reading':   return checkMeterNoReading(env, rule, shouldFire);
    case 'meter_zero_reading': return checkMeterZeroReading(env, rule, shouldFire);
    case 'demand_threshold':   return checkDemandThreshold(env, rule, shouldFire);
    default:
      console.warn(`[notificationRunner] Unknown rule type: ${rule.rule_type}`);
  }
}
