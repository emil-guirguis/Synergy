/**
 * Header bell — count badge + popover list, backed by whatever NotificationsApi
 * the host app hands it (see types.ts). Drop into AppLayoutConfig.notificationComponent
 * (framework/frontend/layout) to replace the layout's built-in generic dropdown.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  Badge,
  IconButton,
  Popover,
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
} from '@mui/material';
import NotificationsIcon from '@mui/icons-material/Notifications';
import type { NotificationRecord, NotificationsApi } from './types';
import NotificationList from './NotificationList';

interface NotificationBellProps {
  api: NotificationsApi;
  /** Poll interval in ms for the count badge. Default 60000. */
  refreshInterval?: number;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({
  api,
  refreshInterval = 60000,
}) => {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [count, setCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await api.list(100, 0);
      setNotifications(result.notifications);
      setCount(result.total);
    } catch (err) {
      console.error('[NotificationBell] Error fetching notifications:', err);
      setError('Failed to load notifications');
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  const updateCount = useCallback(async () => {
    try {
      setCount(await api.count());
    } catch (err) {
      console.error('[NotificationBell] Error updating count:', err);
    }
  }, [api]);

  useEffect(() => {
    fetchNotifications();
    const pollInterval = setInterval(() => {
      updateCount();
    }, refreshInterval);
    return () => clearInterval(pollInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshInterval, api]);

  const handleBellClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
    setIsOpen(true);
    fetchNotifications();
  };

  const handleClose = () => {
    setAnchorEl(null);
    setIsOpen(false);
  };

  const handleClearNotification = async (notificationId: string) => {
    try {
      await api.clear(notificationId);
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
      setCount((c) => Math.max(0, c - 1));
    } catch (err) {
      console.error('[NotificationBell] Error clearing notification:', err);
      setError('Failed to clear notification');
    }
  };

  const handleAcknowledge = async (notificationId: string) => {
    try {
      await api.acknowledge(notificationId);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, status: 'acknowledged' as const } : n))
      );
    } catch (err) {
      console.error('[NotificationBell] Error acknowledging notification:', err);
      setError('Failed to acknowledge notification');
    }
  };

  const handleClearAll = async () => {
    try {
      await api.clearAll();
      setNotifications([]);
      setCount(0);
      handleClose();
    } catch (err) {
      console.error('[NotificationBell] Error clearing all notifications:', err);
      setError('Failed to clear all notifications');
    }
  };

  return (
    <>
      <IconButton
        color="inherit"
        onClick={handleBellClick}
        aria-label="notifications"
        data-testid="notification-bell-button"
      >
        <Badge badgeContent={count} color="error">
          <NotificationsIcon />
        </Badge>
      </IconButton>

      <Popover
        open={isOpen}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        data-testid="notification-popover"
      >
        <Box sx={{ width: 400, maxHeight: 500, p: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">Notifications ({count})</Typography>
            {count > 0 && (
              <Button size="small" color="error" onClick={handleClearAll} data-testid="clear-all-button">
                Clear All
              </Button>
            )}
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {isLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
              <CircularProgress size={24} />
            </Box>
          )}

          {!isLoading &&
            (notifications.length === 0 ? (
              <Typography color="textSecondary" align="center" sx={{ py: 2 }}>
                No notifications
              </Typography>
            ) : (
              <NotificationList
                notifications={notifications}
                onClear={handleClearNotification}
                onAcknowledge={handleAcknowledge}
              />
            ))}
        </Box>
      </Popover>
    </>
  );
};

export default NotificationBell;
