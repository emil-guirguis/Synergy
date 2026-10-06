/**
 * The bell used to show a message with no indication of who sent it — the
 * table recorded only the recipient. These cover the From line, including the
 * system-raised rows that must NOT grow one.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NotificationList } from './NotificationList';
import type { NotificationRecord } from './types';

const base: NotificationRecord = {
  id: '1',
  notification_type: 'ai_message',
  severity: 'info',
  title: 'Check the Riverside order',
  description: 'The ship date moved to Friday.',
  created_at: new Date().toISOString(),
  status: 'open',
  acknowledged_at: null,
};

function renderList(notifications: NotificationRecord[]) {
  return render(<NotificationList notifications={notifications} onClear={vi.fn()} />);
}

describe('NotificationList sender', () => {
  it('shows who the message is from', () => {
    renderList([{ ...base, created_by_name: 'Emil Guirguis' }]);
    expect(screen.getByTestId('notification-sender-1')).toHaveTextContent('From Emil Guirguis');
  });

  it('shows no From line for a system-raised notification', () => {
    renderList([{ ...base, notification_type: 'qb_sync_failed', created_by_name: null }]);
    expect(screen.queryByTestId('notification-sender-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it('treats a missing sender the same as an absent one', () => {
    renderList([base]);
    expect(screen.queryByTestId('notification-sender-1')).not.toBeInTheDocument();
  });

  it('keeps the title and description alongside the sender', () => {
    renderList([{ ...base, created_by_name: 'Emil Guirguis' }]);
    expect(screen.getByText('Check the Riverside order')).toBeInTheDocument();
    expect(screen.getByText('The ship date moved to Friday.')).toBeInTheDocument();
  });

  it('labels each row independently when some have senders and some do not', () => {
    renderList([
      { ...base, id: '1', created_by_name: 'Emil Guirguis' },
      { ...base, id: '2', notification_type: 'qb_sync_failed', created_by_name: null },
    ]);
    expect(screen.getByTestId('notification-sender-1')).toHaveTextContent('From Emil Guirguis');
    expect(screen.queryByTestId('notification-sender-2')).not.toBeInTheDocument();
  });
});
