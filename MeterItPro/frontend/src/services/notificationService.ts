/**
 * Notification Service
 * 
 * Handles API calls for notification operations
 */

import { apiClient } from './apiClient';
import type {
  Notification,
  NotificationListResponse,
} from '../types/notifications';

export const notificationService = {
  /**
   * Get all non-cleared notifications
   */
  async listNotifications(limit = 100, offset = 0): Promise<NotificationListResponse> {
    const response = await apiClient.get('/notifications', {
      params: { limit, offset }
    });
    return response.data.data;
  },

  /**
   * Get count of non-cleared notifications
   */
  async getNotificationCount(): Promise<number> {
    const response = await apiClient.get('/notifications/count');
    return response.data.data.count;
  },

  /**
   * Create a new notification
   */
  async createNotification(params: {
    notification_type: string;
    title: string;
    severity?: string;
    description?: string;
    meter_id?: string | null;
    meter_element_id?: string | null;
    user_id?: string | null;
  }): Promise<Notification> {
    const response = await apiClient.post('/notifications', params);
    return response.data.data.notification;
  },

  /**
   * Reply to whoever raised a notification — posts a new one back to them.
   */
  async replyToNotification(notification: { id: string; notification_type: string; title: string; created_by?: string | number | null }, message: string): Promise<void> {
    await apiClient.post('/notifications', {
      notification_type: notification.notification_type,
      title: `Re: ${notification.title}`,
      description: message,
      severity: 'info',
      user_id: notification.created_by,
    });
  },

  /**
   * Acknowledge a notification — stops re-notify emails, keeps the alert visible
   */
  async acknowledgeNotification(notificationId: string): Promise<void> {
    await apiClient.post(`/notifications/${notificationId}/acknowledge`);
  },

  /**
   * Clear (delete) a specific notification
   */
  async clearNotification(notificationId: string): Promise<void> {
    await apiClient.delete(`/notifications/${notificationId}`);
  },

  /**
   * Clear (delete) all notifications
   */
  async clearAllNotifications(): Promise<number> {
    const response = await apiClient.delete('/notifications');
    return response.data.data.deleted_count;
  },

};
