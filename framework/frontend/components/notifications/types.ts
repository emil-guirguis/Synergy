/**
 * Shared types for the header notification bell — matches the shape returned
 * by framework/backend/api/base/notifications.ts.
 */
export type NotificationSeverity = 'info' | 'warning' | 'error';
export type NotificationStatus = 'open' | 'acknowledged';

export interface NotificationRecord {
  id: string; // maps from notification_id
  notification_type: string;
  severity: NotificationSeverity;
  title: string;
  description: string | null;
  created_at: string;
  status: NotificationStatus;
  acknowledged_at: string | null;
  /** Display name of whoever raised it. Null for system-raised rows (cron
   *  thresholds, sync failures), which show no From line. */
  created_by_name?: string | null;
  /** Id of whoever raised it, so a reply knows who to address — same null
   *  rule as created_by_name. */
  created_by?: string | number | null;
  /** Deep link to the record this is about (e.g. Share) — renders the title
   *  as a link when present, null otherwise. */
  link_url?: string | null;
}

export interface NotificationListResult {
  notifications: NotificationRecord[];
  total: number;
}

/**
 * The app-supplied API surface the bell talks to. Each app implements this
 * over its own apiClient/fetch helper — see MeterItPro's notificationService.ts
 * and TBWC's notificationsService.ts.
 */
export interface NotificationsApi {
  list(limit?: number, offset?: number): Promise<NotificationListResult>;
  count(): Promise<number>;
  acknowledge(notificationId: string): Promise<void>;
  clear(notificationId: string): Promise<void>;
  clearAll(): Promise<number>;
  /** Send a message back to whoever raised a notification. Optional — the
   *  reply box only renders when both this and the notification's
   *  created_by are present, so an app that hasn't wired this up is
   *  unaffected. */
  reply?(notification: NotificationRecord, message: string): Promise<void>;
}
