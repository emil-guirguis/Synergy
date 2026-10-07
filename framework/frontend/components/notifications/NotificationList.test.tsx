/**
 * The bell used to show a message with no indication of who sent it — the
 * table recorded only the recipient. These cover the sender pill (replacing
 * the generic type chip once there's a name) and the reply box under it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function renderList(notifications: NotificationRecord[], extra: { onReply?: (n: NotificationRecord, m: string) => Promise<void> | void } = {}) {
  return render(<NotificationList notifications={notifications} onClear={vi.fn()} {...extra} />);
}

describe('NotificationList sender', () => {
  it('shows who the message is from as a pill, in place of the type chip', () => {
    renderList([{ ...base, created_by_name: 'Emil Guirguis' }]);
    expect(screen.getByTestId('notification-sender-chip-1')).toHaveTextContent('Emil Guirguis');
    expect(screen.queryByText('Ai Message')).not.toBeInTheDocument();
  });

  it('falls back to the type chip for a system-raised notification', () => {
    renderList([{ ...base, notification_type: 'qb_sync_failed', created_by_name: null }]);
    expect(screen.queryByTestId('notification-sender-chip-1')).not.toBeInTheDocument();
    expect(screen.getByText('Qb Sync Failed')).toBeInTheDocument();
  });

  it('treats a missing sender the same as an absent one', () => {
    renderList([base]);
    expect(screen.queryByTestId('notification-sender-chip-1')).not.toBeInTheDocument();
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
    expect(screen.getByTestId('notification-sender-chip-1')).toHaveTextContent('Emil Guirguis');
    expect(screen.queryByTestId('notification-sender-chip-2')).not.toBeInTheDocument();
  });
});

describe('NotificationList reply', () => {
  it('shows no reply box when the host app has not wired onReply', () => {
    renderList([{ ...base, created_by: 'u1', created_by_name: 'Emil Guirguis' }]);
    expect(screen.queryByTestId('notification-reply-input-1')).not.toBeInTheDocument();
  });

  it('shows no reply box when the notification has no sender to reply to', () => {
    renderList([{ ...base, notification_type: 'qb_sync_failed', created_by_name: null, created_by: null }], {
      onReply: vi.fn(),
    });
    expect(screen.queryByTestId('notification-reply-input-1')).not.toBeInTheDocument();
  });

  it('sends a reply and confirms it', async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    renderList([{ ...base, created_by: 'u1', created_by_name: 'Emil Guirguis' }], { onReply });

    const user = userEvent.setup();
    await user.type(screen.getByTestId('notification-reply-input-1'), 'On it, thanks');
    await user.click(screen.getByTestId('notification-reply-send-1'));

    expect(onReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', created_by: 'u1' }),
      'On it, thanks'
    );
    expect(await screen.findByText('Reply sent')).toBeInTheDocument();
  });
});
