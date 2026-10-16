/**
 * "Email this file" compose box. The send itself happens on the server (the app's
 * API reads the file out of the bucket and attaches it), which is why this dialog
 * exists at all: a browser cannot hand a file to the machine's mail client, so
 * there is no mail client to compose in.
 *
 * Caller owns the send — DocumentsGrid passes `api.email(documentId, …)`, the rep
 * portal's Resources browser passes its own path-based endpoint — so this file
 * stays app- and route-agnostic.
 *
 * To is deliberately blank (the sender types it), subject defaults to the file
 * name, and the message defaults to a one-line note the sender can replace.
 */
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { subjectForFile } from './emailDocument';
import type { EmailDocumentInput } from './types';

export interface EmailDocumentDialogProps {
  open: boolean;
  onClose: () => void;
  /** Attached file's name — the subject default, and shown as the attachment chip. */
  fileName: string;
  /** Human-readable file size, when the caller knows it (e.g. "1.4 MB"). */
  fileSizeLabel?: string;
  /** Sends it. Resolves with the addresses that were sent to. */
  onSend: (input: EmailDocumentInput) => Promise<string[]>;
  /** Shown once the send succeeds, so the caller can surface its own toast too. */
  onSent?: (recipients: string[]) => void;
  /** Prefills the message body; defaults to a one-liner naming the file. */
  defaultMessage?: string;
}

export const EmailDocumentDialog: React.FC<EmailDocumentDialogProps> = ({
  open,
  onClose,
  fileName,
  fileSizeLabel,
  onSend,
  onSent,
  defaultMessage,
}) => {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState(() => subjectForFile(fileName));
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on each open: the dialog is mounted once per grid, so last send's
  // recipient must not linger into the next file's email.
  useEffect(() => {
    if (!open) return;
    setTo('');
    setSubject(subjectForFile(fileName));
    setMessage(defaultMessage ?? `Attached: ${fileName}`);
    setError(null);
    setSending(false);
  }, [open, fileName, defaultMessage]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const recipients = await onSend({ to, subject, message });
      onSent?.(recipients);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not send the email');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={sending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Email {fileName}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        <TextField
          label="To"
          placeholder="name@example.com"
          helperText="Separate several addresses with commas."
          value={to}
          onChange={(e) => setTo(e.target.value)}
          fullWidth
          autoFocus
          margin="dense"
          disabled={sending}
          inputProps={{ 'data-testid': 'email-doc-to' }}
        />
        <TextField
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          fullWidth
          margin="dense"
          disabled={sending}
          inputProps={{ 'data-testid': 'email-doc-subject' }}
        />
        <TextField
          label="Message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          fullWidth
          multiline
          minRows={4}
          margin="dense"
          disabled={sending}
          inputProps={{ 'data-testid': 'email-doc-message' }}
        />
        <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Attachment: {fileName}
            {fileSizeLabel ? ` (${fileSizeLabel})` : ''}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Sent by the system account with your address as the reply-to, so replies come back to you. It will not
          appear in your own Sent folder.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void send()}
          disabled={sending || !to.trim()}
          startIcon={sending ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default EmailDocumentDialog;
