import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import { NotificationList, type NotificationRecord } from '@meterit/framework-frontend/components/notifications';
import { notificationsService } from '../services/notificationsService';

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await notificationsService.list(200, 0);
      setNotifications(result.notifications);
      setTotal(result.total);
    } catch (err) {
      console.error('[NotificationsPage] Error loading notifications:', err);
      setError('Failed to load notifications');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAcknowledge = async (id: string) => {
    await notificationsService.acknowledge(id);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, status: 'acknowledged' as const } : n)));
  };

  const handleClear = async (id: string) => {
    await notificationsService.clear(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setTotal((t) => Math.max(0, t - 1));
  };

  const handleClearAll = async () => {
    await notificationsService.clearAll();
    setNotifications([]);
    setTotal(0);
  };

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4" fontWeight={700}>
          Notifications
        </Typography>
        {total > 0 && (
          <Button color="error" onClick={handleClearAll}>
            Clear All
          </Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : notifications.length === 0 ? (
        <Typography color="textSecondary">No notifications</Typography>
      ) : (
        <NotificationList notifications={notifications} onClear={handleClear} onAcknowledge={handleAcknowledge} />
      )}
    </Box>
  );
}
