import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  CircularProgress,
  Box,
} from '@mui/material';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { ordersService } from './ordersStore';
import { useAuth } from '../../hooks/useAuth';

export interface EmailOrderDialogProps {
  open: boolean;
  onClose: () => void;
  orderId: string | number;
}

function defaultSubject(refNumber: string | null, jobName: string | null): string {
  const parts = [refNumber ? `Order ${refNumber}` : 'Order'];
  if (jobName) parts.push(jobName);
  return parts.join(' - ');
}

function defaultMessage(refNumber: string | null, jobName: string | null, senderName: string): string {
  const orderInfo = [refNumber ? `#${refNumber}` : null, jobName].filter(Boolean).join(' - ');
  return `Hello,\n\nAttached is the order${orderInfo ? ` ${orderInfo}` : ''}.\n\nThanks,\n${senderName}`;
}

/**
 * "Email this order to the customer" — builds a PDF server-side (pdf-lib,
 * see api/worker/pdf/) and sends it via the same TBWC mail pipeline AI
 * Chat's email_order tool already uses (routes/orders.ts's POST /:id/email).
 * From/Subject/Message all prefill with sensible defaults and are editable;
 * the envelope sender itself is always the fixed system account (SMTP_FROM)
 * — From here drives Reply-To instead, so a customer's reply reaches the rep.
 */
export const EmailOrderDialog: React.FC<EmailOrderDialogProps> = ({ open, onClose, orderId }) => {
  const { user } = useAuth();
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [refNumber, setRefNumber] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [hadEmailOnFile, setHadEmailOnFile] = useState(true);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const senderName = user?.name || [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'TBWC Technology';
    // Reply-To defaults to whoever is actually sending this (the logged-in
    // user), not the order's assigned rep — an admin/employee can send on a
    // rep's behalf, and replies should reach the person who hit Send.
    setFrom(user?.email ?? '');
    setTo('');
    setSubject('');
    setMessage('');
    setRefNumber(null);
    setCustomerName(null);
    setHadEmailOnFile(true);
    setPdfError(null);
    setError(null);
    setLoadingPreview(true);
    ordersService
      .getEmailPreview(orderId)
      .then((preview) => {
        setTo(preview.customerEmail ?? '');
        setHadEmailOnFile(!!preview.customerEmail);
        setRefNumber(preview.refNumber);
        setCustomerName(preview.customerName);
        setSubject(defaultSubject(preview.refNumber, preview.jobName));
        setMessage(defaultMessage(preview.refNumber, preview.jobName, senderName));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load order'))
      .finally(() => setLoadingPreview(false));

    let url: string | null = null;
    ordersService
      .getEmailPdf(orderId)
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setPdfUrl(url);
      })
      .catch((err) => setPdfError(err instanceof Error ? err.message : 'Failed to load PDF preview'));

    return () => {
      if (url) URL.revokeObjectURL(url);
      setPdfUrl(null);
    };
  }, [open, orderId, user]);

  const handleSend = async () => {
    if (!to.trim()) return;
    setSending(true);
    setError(null);
    try {
      await ordersService.sendEmail(orderId, {
        recipientEmail: to.trim(),
        subject: subject.trim() || undefined,
        message: message.trim() || undefined,
        replyTo: from.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={sending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Email Order{refNumber ? ` ${refNumber}` : ''}</DialogTitle>
      <DialogContent>
        {error && (
          <Typography variant="body2" color="error" sx={{ mb: 1.5 }}>
            {error}
          </Typography>
        )}
        {loadingPreview ? (
          <CircularProgress size={20} />
        ) : (
          <>
            {customerName && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                {customerName}
              </Typography>
            )}
            <TextField
              label="From (reply-to)"
              type="email"
              fullWidth
              autoFocus
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              disabled={sending}
              placeholder="you@tbwcinc.com"
              helperText="Sent via TBWC Technology — replies go here."
              sx={{ mb: 2 }}
            />
            {!hadEmailOnFile && (
              <Typography variant="caption" color="warning.main" sx={{ display: 'block', mb: 1 }}>
                No email on file for this customer — enter one below.
              </Typography>
            )}
            <TextField
              label="Send to"
              type="email"
              fullWidth
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={sending}
              placeholder="customer@example.com"
              sx={{ mb: 2 }}
            />
            <TextField
              label="Subject"
              fullWidth
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={sending}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Message"
              fullWidth
              multiline
              minRows={8}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={sending}
              sx={{ mb: 2 }}
            />

            {pdfError ? (
              <Typography variant="caption" color="error">
                {pdfError}
              </Typography>
            ) : (
              <Box
                component={pdfUrl ? 'a' : 'div'}
                href={pdfUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1.5,
                  py: 1,
                  border: '1px solid rgba(0,0,0,0.15)',
                  borderRadius: 1.5,
                  textDecoration: 'none',
                  color: 'text.primary',
                  cursor: pdfUrl ? 'pointer' : 'default',
                  '&:hover': pdfUrl ? { bgcolor: 'action.hover' } : undefined,
                }}
              >
                {pdfUrl ? <PictureAsPdfIcon color="error" fontSize="small" /> : <CircularProgress size={16} />}
                <Typography variant="caption">
                  {`Order${refNumber ? `-${refNumber}` : ''}.pdf`}
                </Typography>
              </Box>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button onClick={handleSend} variant="contained" disabled={!to.trim() || sending || loadingPreview}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default EmailOrderDialog;
