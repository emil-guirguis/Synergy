/**
 * Scheduled AI-drafted notifications — the framework-owned half.
 *
 * Each row in `scheduled_notification_rule` names a cron schedule (5-field,
 * UTC) and a free-text `prompt` describing what to write about. When a rule's
 * cron matches the current tick, runScheduledNotifications() calls Claude
 * with that prompt, drafts a short {title, description}, and inserts it via
 * notifications.ts's createNotification (users_id NULL = broadcast to
 * everyone — same visibility rule as every other notification).
 *
 * Unlike MeterItPro's notificationRunner.ts (deterministic violation checks
 * against meter data), this module has no domain data to evaluate — the
 * whole point is to let an admin describe a recurring message in English
 * ("remind reps to submit expense reports the last Friday of the month") and
 * have the model phrase it fresh each run, rather than hand-coding a template
 * per message. For threshold/violation-style alerts, use the app's own
 * notificationRunner pattern instead; this module is for free-text prompts.
 *
 * Cron matcher mirrors MeterItPro's worker/cronMatcher.ts (not imported from
 * there to avoid a cross-app dependency — this is the framework-shared copy).
 *
 * Deliberately not importing Hono (same duplicate-package hazard as
 * notifications.ts/auth.ts): plain functions, each app calls
 * runScheduledNotifications() from its own Worker's scheduled() handler.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ExecQueryFn } from './crud';
import { createNotification, type NotificationsOptions, type NotificationSeverity } from './notifications';

export interface ScheduledNotificationRuleRow {
  scheduled_notification_rule_id: number;
  name: string;
  schedule_cron: string;
  prompt: string;
  users_id: string | number | null;
  severity: NotificationSeverity;
}

export interface ScheduledNotificationsOptions {
  /** Override only if an app names the table something else. */
  table?: string;
  /**
   * Column holding tenant scope, same convention as NotificationsOptions.
   * Pass `null` for a single-tenant app (TBWC) — the rule table then has no
   * tenant_id column and every rule runs globally. Default 'tenant_id'.
   */
  tenantColumn?: string | null;
  /** Forwarded to createNotification() — must match what the app's own
   *  notifications.ts route passes (e.g. `{ tenantColumn: null }` for TBWC). */
  notificationOptions?: NotificationsOptions;
}

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DEFAULT_TABLE = 'scheduled_notification_rule';

function tableOf(options?: ScheduledNotificationsOptions): string {
  const table = options?.table ?? DEFAULT_TABLE;
  if (!SAFE_IDENT.test(table)) throw new Error(`Invalid scheduled_notification_rule table: ${table}`);
  return table;
}

function tenantColumnOf(options?: ScheduledNotificationsOptions): string | null {
  if (options && options.tenantColumn === null) return null;
  const col = options?.tenantColumn ?? 'tenant_id';
  if (!SAFE_IDENT.test(col)) throw new Error(`Invalid tenant column: ${col}`);
  return col;
}

// --- Cron matcher (mirrors MeterItPro/api/worker/cronMatcher.ts) --------------

function matchesCronField(field: string, value: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      let start = 0, end = 59;
      if (range !== '*') {
        if (range.includes('-')) {
          [start, end] = range.split('-').map(Number);
        } else {
          start = parseInt(range, 10);
          end = start;
        }
      }
      for (let v = start; v <= end; v += step) {
        if (v === value) return true;
      }
    } else if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      if (value >= s && value <= e) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

/** Returns true if `now` matches the given 5-field cron expression (UTC). */
export function matchesCronSchedule(schedule: string, now: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minuteField, hourField, domField, monthField, dowField] = parts;
  return (
    matchesCronField(minuteField, now.getUTCMinutes()) &&
    matchesCronField(hourField, now.getUTCHours()) &&
    matchesCronField(domField, now.getUTCDate()) &&
    matchesCronField(monthField, now.getUTCMonth() + 1) &&
    matchesCronField(dowField, now.getUTCDay())
  );
}

// --- AI drafting ---------------------------------------------------------------

const DRAFT_SYSTEM_PROMPT =
  'You write short in-app notification messages for a business portal. Given the ' +
  'request below, respond with ONLY a JSON object of the shape ' +
  '{"title": string (<=120 chars), "description": string (1-4 sentences, plain text, no markdown)} ' +
  '— no code fence, no commentary before or after the JSON.';

function parseDraft(raw: string): { title: string; description: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(cleaned);
  const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 255) : '';
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  if (!title) throw new Error('Model response had no usable title');
  return { title, description };
}

async function draftNotification(apiKey: string, prompt: string): Promise<{ title: string; description: string }> {
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    system: DRAFT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  return parseDraft(text);
}

// --- Runner ---------------------------------------------------------------------

/**
 * Evaluates every active rule against `now`; for each whose schedule_cron
 * matches this tick, drafts fresh text with Claude and inserts a notification.
 * A per-rule failure (bad cron, model error, bad JSON) is logged and skipped —
 * never lets one broken rule stop the others from firing.
 */
export async function runScheduledNotifications(
  execQuery: ExecQueryFn,
  env: any,
  now: Date = new Date(),
  options: ScheduledNotificationsOptions = {}
): Promise<void> {
  const apiKey = (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[scheduledNotifications] ANTHROPIC_API_KEY not set - skipping');
    return;
  }

  const table = tableOf(options);
  const tenantCol = tenantColumnOf(options);
  const cols = `scheduled_notification_rule_id, ${tenantCol ? `${tenantCol}, ` : ''}name, schedule_cron, prompt, users_id, severity`;

  const result = await execQuery(
    env,
    `SELECT ${cols} FROM public.${table} WHERE active = true`,
    [],
    'scheduledNotifications.list'
  );

  for (const rule of result.rows as (ScheduledNotificationRuleRow & Record<string, any>)[]) {
    if (!matchesCronSchedule(rule.schedule_cron, now)) continue;
    try {
      const { title, description } = await draftNotification(apiKey, rule.prompt);
      const tenantId = tenantCol ? rule[tenantCol] ?? null : null;
      await createNotification(
        execQuery,
        env,
        tenantId,
        {
          notificationType: 'scheduled_ai',
          title,
          description,
          severity: rule.severity ?? 'info',
          usersId: rule.users_id ?? null,
          createdByName: `AI (${rule.name})`,
        },
        options.notificationOptions
      );
      await execQuery(
        env,
        `UPDATE public.${table} SET last_run_at = NOW() WHERE scheduled_notification_rule_id = $1`,
        [rule.scheduled_notification_rule_id],
        'scheduledNotifications.touch'
      );
      console.log(`[cron] Scheduled notification rule ${rule.scheduled_notification_rule_id} (${rule.name}) fired`);
    } catch (err) {
      console.error(
        `[scheduledNotifications] rule ${rule.scheduled_notification_rule_id} (${rule.name}) failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
