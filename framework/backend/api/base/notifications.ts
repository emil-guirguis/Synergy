/**
 * Shared in-app notification module — the framework-owned half.
 *
 * A tenant-scoped (or single-tenant) feed of short-lived alerts, read via the
 * header bell (framework/frontend/components/notifications). Any app can raise
 * one — a QB sync failure, a stale meter, a rep lead — since notification_type
 * and severity are free-form strings, not a fixed enum. This module owns only
 * the generic CRUD/ack lifecycle; domain logic that decides WHEN to raise one
 * (thresholds, dedup, cron) stays app-side (see MeterItPro's notificationRunner).
 *
 * Visibility rule baked into every query: a row with users_id NULL is a
 * broadcast (everyone in the tenant sees it), otherwise only that user does.
 *
 * Deliberately not importing Hono (same duplicate-package hazard as
 * documents.ts): plain functions, each app wraps them in its own Hono route
 * with its own auth middleware — see TBWC/api/worker/routes/notifications.ts
 * and MeterItPro/api/worker/routes/notifications.ts.
 */
import type { ExecQueryFn } from './crud';

export type NotificationSeverity = 'info' | 'warning' | 'error';
export type NotificationStatus = 'open' | 'acknowledged';

export interface NotificationRow {
  notification_id: number;
  tenant_id: number | null;
  users_id: string | null;
  notification_type: string;
  severity: NotificationSeverity;
  title: string;
  description: string | null;
  created_at: string;
  status: NotificationStatus;
  first_detected_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  /** Who raised it. Null for system-raised rows (cron thresholds, sync
   *  failures), which is how the bell decides whether to show a From line. */
  created_by: string | number | null;
  /** Sender's display name as it read when sent - denormalised rather than
   *  joined, since each app's users table has a different key type. */
  created_by_name: string | null;
}

export interface CreateNotificationInput {
  notificationType: string;
  title: string;
  severity?: NotificationSeverity;
  description?: string | null;
  usersId?: string | number | null;
  /** The acting user, when a person raised this rather than a scheduled job.
   *  Pass both or neither - a name with no id is still accepted, but an id
   *  alone leaves the bell with nothing to show. */
  createdBy?: string | number | null;
  createdByName?: string | null;
}

export interface NotificationsOptions {
  /** Override only if an app names the table something else. */
  table?: string;
  /**
   * Column apps use for multi-tenant scoping. Pass `null` for a single-tenant
   * app (e.g. TBWC) to drop tenant filtering entirely — `tenantId` is then
   * ignored by every function below. Default 'tenant_id'.
   */
  tenantColumn?: string | null;
}

const DEFAULT_TABLE = 'notification';
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function columnsOf(options?: NotificationsOptions): string {
  const tenantCol = tenantColumnOf(options);
  return `notification_id, ${tenantCol ? `${tenantCol}, ` : ''}users_id, notification_type, severity, title,
          description, created_at, status, first_detected_at, acknowledged_at, acknowledged_by,
          created_by, created_by_name`;
}

/** Thrown for bad client input; app routes map this to a 400. */
export class NotificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationValidationError';
  }
}

function tableOf(options?: NotificationsOptions): string {
  const table = options?.table ?? DEFAULT_TABLE;
  if (!SAFE_IDENT.test(table)) throw new Error(`Invalid notifications table: ${table}`);
  return table;
}

function tenantColumnOf(options?: NotificationsOptions): string | null {
  if (options && options.tenantColumn === null) return null;
  const col = options?.tenantColumn ?? 'tenant_id';
  if (!SAFE_IDENT.test(col)) throw new Error(`Invalid tenant column: ${col}`);
  return col;
}

/**
 * Builds the "visible to this user" predicate shared by every query:
 * scoped to the tenant (if the app has one) and to broadcasts + this user's own.
 */
function visibilityClause(
  tenantId: string | number | null | undefined,
  userId: string | number,
  options: NotificationsOptions | undefined,
  params: any[]
): string {
  const clauses: string[] = [];
  const tenantCol = tenantColumnOf(options);
  if (tenantCol) {
    params.push(tenantId);
    clauses.push(`${tenantCol} = $${params.length}`);
  }
  params.push(userId);
  const userParam = params.length;
  clauses.push(`(users_id IS NULL OR users_id = $${userParam})`);
  return clauses.join(' AND ');
}

export async function countNotifications(
  execQuery: ExecQueryFn,
  env: any,
  tenantId: string | number | null,
  userId: string | number,
  options?: NotificationsOptions
): Promise<number> {
  const params: any[] = [];
  const where = visibilityClause(tenantId, userId, options, params);
  const result = await execQuery(
    env,
    `SELECT COUNT(*) as count FROM public.${tableOf(options)} WHERE ${where}`,
    params,
    'notifications.count'
  );
  return parseInt(result.rows[0].count, 10);
}

export async function listNotifications(
  execQuery: ExecQueryFn,
  env: any,
  tenantId: string | number | null,
  userId: string | number,
  limitOffset: { limit?: number; offset?: number } = {},
  options?: NotificationsOptions
): Promise<{ notifications: NotificationRow[]; total: number }> {
  const limit = Math.min(limitOffset.limit ?? 100, 200);
  const offset = limitOffset.offset ?? 0;

  const params: any[] = [];
  const where = visibilityClause(tenantId, userId, options, params);
  const result = await execQuery(
    env,
    `SELECT ${columnsOf(options)} FROM public.${tableOf(options)}
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
    'notifications.list'
  );

  const total = await countNotifications(execQuery, env, tenantId, userId, options);
  return { notifications: result.rows as NotificationRow[], total };
}

export async function createNotification(
  execQuery: ExecQueryFn,
  env: any,
  tenantId: string | number | null,
  input: CreateNotificationInput,
  options?: NotificationsOptions
): Promise<NotificationRow> {
  if (!input.notificationType || !input.title) {
    throw new NotificationValidationError('notificationType and title are required');
  }
  const tenantCol = tenantColumnOf(options);
  const cols = ['users_id', 'notification_type', 'severity', 'title', 'description', 'created_by', 'created_by_name'];
  const vals: any[] = [
    input.usersId ?? null,
    input.notificationType,
    input.severity ?? 'warning',
    input.title,
    input.description ?? null,
    input.createdBy ?? null,
    input.createdByName?.trim() || null,
  ];
  if (tenantCol) {
    cols.unshift(tenantCol);
    vals.unshift(tenantId);
  }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const result = await execQuery(
    env,
    `INSERT INTO public.${tableOf(options)} (${cols.join(', ')})
     VALUES (${placeholders})
     RETURNING ${columnsOf(options)}`,
    vals,
    'notifications.create'
  );
  return result.rows[0] as NotificationRow;
}

export async function acknowledgeNotification(
  execQuery: ExecQueryFn,
  env: any,
  tenantId: string | number | null,
  notificationId: string | number,
  ackBy: string | number,
  options?: NotificationsOptions
): Promise<NotificationRow | null> {
  const params: any[] = [notificationId];
  let where = `notification_id = $1`;
  const tenantCol = tenantColumnOf(options);
  if (tenantCol) {
    params.push(tenantId);
    where += ` AND ${tenantCol} = $${params.length}`;
  }
  params.push(ackBy);
  const ackParam = params.length;

  const result = await execQuery(
    env,
    `UPDATE public.${tableOf(options)}
        SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $${ackParam}
      WHERE ${where}
      RETURNING ${columnsOf(options)}`,
    params,
    'notifications.acknowledge'
  );
  return (result.rows[0] as NotificationRow) ?? null;
}

export async function deleteNotification(
  execQuery: ExecQueryFn,
  env: any,
  tenantId: string | number | null,
  notificationId: string | number,
  options?: NotificationsOptions
): Promise<boolean> {
  const params: any[] = [notificationId];
  let where = `notification_id = $1`;
  const tenantCol = tenantColumnOf(options);
  if (tenantCol) {
    params.push(tenantId);
    where += ` AND ${tenantCol} = $${params.length}`;
  }

  const result = await execQuery(
    env,
    `DELETE FROM public.${tableOf(options)} WHERE ${where}`,
    params,
    'notifications.delete'
  );
  return (result.rowCount ?? 0) > 0;
}

/** Deletes every notification visible to this user (broadcasts + their own). */
export async function deleteAllNotifications(
  execQuery: ExecQueryFn,
  env: any,
  tenantId: string | number | null,
  userId: string | number,
  options?: NotificationsOptions
): Promise<number> {
  const params: any[] = [];
  const where = visibilityClause(tenantId, userId, options, params);
  const result = await execQuery(
    env,
    `DELETE FROM public.${tableOf(options)} WHERE ${where}`,
    params,
    'notifications.deleteAll'
  );
  return result.rowCount ?? 0;
}
