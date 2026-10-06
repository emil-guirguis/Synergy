/**
 * Renders a list of notifications with ack/clear actions.
 */
import React from 'react';
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
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import type { NotificationRecord, NotificationSeverity } from './types';

interface NotificationListProps {
  notifications: NotificationRecord[];
  onClear: (notificationId: string) => void;
  onAcknowledge?: (notificationId: string) => void;
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

export const NotificationList: React.FC<NotificationListProps> = ({
  notifications,
  onClear,
  onAcknowledge,
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
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {notification.title}
                  </Typography>
                  <Chip
                    label={getTypeLabel(notification.notification_type)}
                    size="small"
                    color={getSeverityColor(notification.severity)}
                    variant="outlined"
                  />
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
                  {notification.created_by_name && (
                    <Typography
                      variant="caption"
                      display="block"
                      color="textSecondary"
                      sx={{ fontWeight: 600 }}
                      data-testid={`notification-sender-${notification.id}`}
                    >
                      From {notification.created_by_name}
                    </Typography>
                  )}
                  <Typography variant="caption" display="block" color="textSecondary">
                    {formatTimestamp(notification.created_at)}
                  </Typography>
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
