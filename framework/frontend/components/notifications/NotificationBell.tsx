/**
 * Header bell — count badge + popover list, backed by whatever NotificationsApi
 * the host app hands it (see types.ts). Drop into AppLayoutConfig.notificationComponent
 * (framework/frontend/layout) to replace the layout's built-in generic dropdown.
 *
 * Background poll (every `refreshInterval`) diffs the fetched list against
 * notification ids already seen this session — any new OPEN one triggers a
 * chime + toast, so a notification that arrives while the bell is closed
 * still gets noticed. The first load on mount only seeds the seen-set
 * (no chime/toast for notifications that already existed before this page
 * loaded).
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Badge,
  IconButton,
  Popover,
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Snackbar,
} from '@mui/material';
import NotificationsIcon from '@mui/icons-material/Notifications';
import type { NotificationRecord, NotificationsApi, NotificationSeverity } from './types';
import NotificationList from './NotificationList';

interface NotificationBellProps {
  api: NotificationsApi;
  /** Poll interval in ms for picking up new notifications. Default 60000. */
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
  const [toast, setToast] = useState<{ message: string; severity: NotificationSeverity } | null>(null);

  // null until the first fetch completes — that first fetch only seeds this,
  // it never chimes/toasts (otherwise every pre-existing open notification
  // would announce itself the moment the page loads).
  const seenIdsRef = useRef<Set<string> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const playChime = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new AudioCtx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (err) {
      console.error('[NotificationBell] Error playing chime:', err);
    }
  }, []);

  // AudioContext can only be resumed as a result of a user gesture in most
  // browsers — warm it up on the first click/keypress anywhere on the page
  // so a chime triggered later by a background poll actually plays.
  useEffect(() => {
    const unlock = () => {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx && !audioCtxRef.current) audioCtxRef.current = new AudioCtx();
      audioCtxRef.current?.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const refresh = useCallback(async (opts: { silent?: boolean } = {}) => {
    const silent = opts.silent ?? false;
    try {
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      const result = await api.list(100, 0);

      const seen = seenIdsRef.current;
      if (seen) {
        const fresh = result.notifications.filter((n) => n.status === 'open' && !seen.has(n.id));
        if (fresh.length > 0) {
          playChime();
          setToast({
            message: fresh.length === 1 ? fresh[0].title : `${fresh[0].title} (+${fresh.length - 1} more)`,
            severity: fresh[0].severity,
          });
        }
      }
      seenIdsRef.current = new Set(result.notifications.map((n) => n.id));

      setNotifications(result.notifications);
      setCount(result.total);
    } catch (err) {
      console.error('[NotificationBell] Error fetching notifications:', err);
      if (!silent) setError('Failed to load notifications');
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [api, playChime]);

  useEffect(() => {
    refresh();
    const pollInterval = setInterval(() => refresh({ silent: true }), refreshInterval);
    return () => clearInterval(pollInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshInterval, api]);

  const handleBellClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
    setIsOpen(true);
    refresh();
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

  const handleReply = api.reply
    ? async (notification: NotificationRecord, message: string) => {
        try {
          await api.reply!(notification, message);
        } catch (err) {
          console.error('[NotificationBell] Error sending reply:', err);
          setError('Failed to send reply');
          throw err;
        }
      }
    : undefined;

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
                onReply={handleReply}
              />
            ))}
        </Box>
      </Popover>

      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        {toast ? (
          <Alert severity={toast.severity} variant="filled" onClose={() => setToast(null)}>
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </>
  );
};

export default NotificationBell;
