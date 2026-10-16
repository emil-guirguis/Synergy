/**
 * The dialog is the only place a sender types where a file goes, so: To starts
 * blank and gates Send, subject defaults to the file name, a failed send keeps
 * the dialog open with the server's message, and reopening never carries the last
 * recipient over to the next file.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailDocumentDialog } from './EmailDocumentDialog';

afterEach(cleanup);

const to = () => screen.getByTestId('email-doc-to') as HTMLInputElement;
const subject = () => screen.getByTestId('email-doc-subject') as HTMLInputElement;
const message = () => screen.getByTestId('email-doc-message') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: /^send$/i });

function setup(props: Partial<React.ComponentProps<typeof EmailDocumentDialog>> = {}) {
  const onSend = props.onSend ?? vi.fn().mockResolvedValue(['c@x.com']);
  const onClose = props.onClose ?? vi.fn();
  const onSent = props.onSent ?? vi.fn();
  const view = render(
    <EmailDocumentDialog open onClose={onClose} fileName="Packing Slip.pdf" onSend={onSend} onSent={onSent} {...props} />
  );
  return { onSend, onClose, onSent, view };
}

describe('EmailDocumentDialog', () => {
  it('starts with a blank To and the file name, minus extension, as subject', () => {
    setup();
    expect(to().value).toBe('');
    expect(subject().value).toBe('Packing Slip');
    expect(message().value).toBe('Attached: Packing Slip.pdf');
  });

  it('keeps Send disabled until an address is typed', async () => {
    setup();
    expect(sendButton()).toBeDisabled();
    await userEvent.type(to(), 'c@x.com');
    expect(sendButton()).toBeEnabled();
  });

  it('sends what the user typed, then reports and closes', async () => {
    const { onSend, onSent, onClose } = setup();
    await userEvent.type(to(), 'a@x.com, b@y.com');
    await userEvent.clear(subject());
    await userEvent.type(subject(), 'Your slip');
    await userEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend).toHaveBeenCalledWith({
      to: 'a@x.com, b@y.com',
      subject: 'Your slip',
      message: 'Attached: Packing Slip.pdf',
    });
    expect(onSent).toHaveBeenCalledWith(['c@x.com']);
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open and shows the server’s message when the send fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('slip.pdf is 14.2MB — too large to email'));
    const { onClose } = setup({ onSend });
    await userEvent.type(to(), 'c@x.com');
    await userEvent.click(sendButton());

    expect(await screen.findByText(/too large to email/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    // Still sendable after fixing the recipient — not a dead dialog.
    expect(sendButton()).toBeEnabled();
  });

  it('prefills the message from defaultMessage when given', () => {
    setup({ defaultMessage: 'Signed copy for the job file.' });
    expect(message().value).toBe('Signed copy for the job file.');
  });

  it('resets To and subject when reopened for a different file', async () => {
    const { view } = setup();
    await userEvent.type(to(), 'first@x.com');

    view.rerender(
      <EmailDocumentDialog open={false} onClose={vi.fn()} fileName="Packing Slip.pdf" onSend={vi.fn()} />
    );
    view.rerender(<EmailDocumentDialog open onClose={vi.fn()} fileName="Invoice 12.pdf" onSend={vi.fn()} />);

    expect(to().value).toBe('');
    expect(subject().value).toBe('Invoice 12');
  });

  it('shows the attachment and its size, and that replies come back to the sender', () => {
    setup({ fileSizeLabel: '1.4 MB' });
    expect(screen.getByText(/Attachment: Packing Slip\.pdf \(1\.4 MB\)/)).toBeTruthy();
    expect(screen.getByText(/reply-to/i)).toBeTruthy();
  });
});
