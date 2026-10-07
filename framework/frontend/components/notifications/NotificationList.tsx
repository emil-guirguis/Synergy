/**
 * Renders a list of notifications with ack/clear actions.
 */
import React, { useState } from 'react';
import {
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
  Chip,
  Box,
  Typography,
  Divider,
  TextField,
  Button,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ReplyIcon from '@mui/icons-material/Reply';
import type { NotificationRecord, NotificationSeverity } from './types';

interface NotificationListProps {
  notifications: NotificationRecord[];
  onClear: (notificationId: string) => void;
  onAcknowledge?: (notificationId: string) => void;
  /** Present only when the host app wired NotificationsApi.reply — see
   *  NotificationBell, which only passes this through when that's true. */
  onReply?: (notification: NotificationRecord, message: string) => Promise<void> | void;
}

function getSeverityColor(severity: NotificationSeverity): 'error' | 'warning' | 'info' {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  return 'info';
}

/** 'demand_threshold' -> 'Demand Threshold' */
function getTypeLabel(type: string): string {
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatTimestamp(timestamp: string): string {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return timestamp;
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Reply textbox shown under a notification that has someone to write back
 *  to. Owns its own draft text so typing in one row never re-renders the
 *  rest of the list. */
const ReplyBox: React.FC<{
  notification: NotificationRecord;
  onReply: (notification: NotificationRecord, message: string) => Promise<void> | void;
}> = ({ notification, onReply }) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await onReply(notification, message);
      setText('');
      setSent(true);
    } catch {
      // Already surfaced via the bell's error Alert — leave the draft in
      // place so the user can retry instead of losing what they typed.
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Typography variant="caption" display="block" color="success.main" sx={{ mt: 0.75 }}>
        Reply sent
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', gap: 0.5, mt: 0.75 }} onClick={(e) => e.stopPropagation()}>
      <TextField
        size="small"
        fullWidth
        placeholder="Reply…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        disabled={sending}
        inputProps={{ 'data-testid': `notification-reply-input-${notification.id}` }}
      />
      <Button
        size="small"
        variant="outlined"
        startIcon={<ReplyIcon fontSize="small" />}
        onClick={send}
        disabled={sending || !text.trim()}
        data-testid={`notification-reply-send-${notification.id}`}
      >
        Send
      </Button>
    </Box>
  );
};

export const NotificationList: React.FC<NotificationListProps> = ({
  notifications,
  onClear,
  onAcknowledge,
  onReply,
}) => {
  return (
    <List sx={{ width: '100%', maxHeight: 400, overflow: 'auto' }}>
      {notifications.map((notification, index) => (
        <React.Fragment key={notification.id}>
          <ListItem
            data-testid={`notification-item-${notification.id}`}
            sx={{ py: 1.5, '&:hover': { backgroundColor: 'action.hover' } }}
          >
            <ListItemText
              // secondary renders inside a <p> by default, and the block below
              // is a <div> - invalid DOM that React warns about on every row.
              secondaryTypographyProps={{ component: 'div' }}
              primary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  {notification.created_by_name ? (
                    <Chip
                      label={notification.created_by_name}
                      size="small"
                      color={getSeverityColor(notification.severity)}
                      variant="outlined"
                      data-testid={`notification-sender-chip-${notification.id}`}
                    />
                  ) : (
                    <Chip
                      label={getTypeLabel(notification.notification_type)}
                      size="small"
                      color={getSeverityColor(notification.severity)}
                      variant="outlined"
                    />
                  )}
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {notification.title}
                  </Typography>
                  {notification.status === 'acknowledged' && (
                    <Chip
                      label="Acked"
                      size="small"
                      color="default"
                      variant="outlined"
                      data-testid={`acked-chip-${notification.id}`}
                    />
                  )}
                </Box>
              }
              secondary={
                <Box sx={{ mt: 0.5 }}>
                  {notification.description && (
                    <Typography variant="caption" display="block" color="textSecondary">
                      {notification.description}
                    </Typography>
                  )}
                  <Typography variant="caption" display="block" color="textSecondary">
                    {formatTimestamp(notification.created_at)}
                  </Typography>
                  {onReply && notification.created_by != null && (
                    <ReplyBox notification={notification} onReply={onReply} />
                  )}
                </Box>
              }
            />
            <ListItemSecondaryAction>
              {onAcknowledge && notification.status !== 'acknowledged' && (
                <IconButton
                  edge="end"
                  aria-label="acknowledge"
                  title="Acknowledge"
                  onClick={() => onAcknowledge(notification.id)}
                  size="small"
                  data-testid={`ack-notification-${notification.id}`}
                >
                  <CheckCircleOutlineIcon fontSize="small" />
                </IconButton>
              )}
              <IconButton
                edge="end"
                aria-label="delete"
                onClick={() => onClear(notification.id)}
                size="small"
                data-testid={`clear-notification-${notification.id}`}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </ListItemSecondaryAction>
          </ListItem>
          {index < notifications.length - 1 && <Divider />}
        </React.Fragment>
      ))}
    </List>
  );
};

export default NotificationList;
