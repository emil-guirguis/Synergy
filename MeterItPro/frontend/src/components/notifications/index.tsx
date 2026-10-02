/**
 * MeterItPro's notification bell — wires the framework's generic
 * NotificationBell to this app's notificationService.
 */
import React from 'react';
import { NotificationBell as FrameworkNotificationBell } from '@meterit/framework-frontend/components/notifications';
import type { NotificationsApi } from '@meterit/framework-frontend/components/notifications';
import { notificationService } from '../../services/notificationService';

const api: NotificationsApi = {
  list: (limit, offset) => notificationService.listNotifications(limit, offset),
  count: () => notificationService.getNotificationCount(),
  acknowledge: (id) => notificationService.acknowledgeNotification(id),
  clear: (id) => notificationService.clearNotification(id),
  clearAll: () => notificationService.clearAllNotifications(),
};

export const NotificationBell: React.FC = () => <FrameworkNotificationBell api={api} />;

export default NotificationBell;
