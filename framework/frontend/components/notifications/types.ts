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
}
