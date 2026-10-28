/**
 * The AR Aging report's row-checkbox "Email" action — sends the next unsent
 * collection notice to however many invoices (1 or many) are selected, via
 * the same server-side send/lock/document path as the AR tab's own
 * per-section Email button (routes/invoices.ts's sendInvoiceNoticeEmail).
 *
 * Each invoice gets its own notice number (whichever slot is next for IT —
 * selected invoices are rarely all at the same stage) and its own customer,
 * so this is a confirm-and-report dialog rather than a compose box: there is
 * no single "To"/subject/body to edit across N different customers.
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
  List,
  ListItem,
  ListItemText,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { invoiceService } from '../invoices/invoiceStore';
import { todayLocal } from '../invoices/noticeActions';
import type { ArAgingInvoice } from '../../types/arAging';

export interface ArNoticeBulkEmailDialogProps {
  open: boolean;
  onClose: () => void;
  invoices: ArAgingInvoice[];
  /** Called once a send attempt has a result, so the list behind the dialog
   *  can refetch (updated notice dates) and clear its selection. */
  onSent: () => void;
}

/** First notice slot (1/2/3) this invoice hasn't sent yet, or null once all
 *  three have a date — mirrors invoices.ts's nextNoticeSlot so the preview
 *  here says the same thing the server is about to do. */
function nextNoticeSlot(row: ArAgingInvoice): 1 | 2 | 3 | null {
  for (const n of [1, 2, 3] as const) {
    if (!(row as any)[`notice_${n}_date`]) return n;
  }
  return null;
}

type RowResult = { success: boolean; message?: string; notice?: number; recipient?: string };

export const ArNoticeBulkEmailDialog: React.FC<ArNoticeBulkEmailDialogProps> = ({ open, onClose, invoices, onSent }) => {
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult> | null>(null);
  // Snapshotted on open rather than read straight from the `invoices` prop:
  // onSent (below) tells the list behind this dialog to refetch, which
  // clears its selection — the very prop this dialog is built from — the
  // instant the send completes, which would otherwise blank the results
  // list out from under the user before they ever saw it.
  const [snapshot, setSnapshot] = useState<ArAgingInvoice[]>([]);

  useEffect(() => {
    if (open) {
      setSending(false);
      setResults(null);
      setSnapshot(invoices);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const eligible = snapshot.filter((inv) => nextNoticeSlot(inv) !== null);
  const ineligible = snapshot.filter((inv) => nextNoticeSlot(inv) === null);

  const handleSend = async () => {
    setSending(true);
    try {
      const rows = await invoiceService.sendNoticeEmailBulk(eligible.map((inv) => inv.id), todayLocal());
      const byId: Record<string, RowResult> = {};
      for (const r of rows) byId[r.id] = r;
      setResults(byId);
      onSent();
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={sending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Email Collection Notice{snapshot.length > 1 ? 's' : ''}</DialogTitle>
      <DialogContent>
        {!results && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Each invoice gets its own copy, emailed to its own customer. The notice sent is whichever is next for
              that invoice.
            </Typography>
            {ineligible.length > 0 && (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                {ineligible.length} of {snapshot.length} selected invoice{ineligible.length > 1 ? 's have' : ' has'} already
                had all 3 notices sent and will be skipped.
              </Alert>
            )}
            <List dense disablePadding>
              {eligible.map((inv) => (
                <ListItem key={inv.id} disableGutters>
                  <ListItemText
                    primary={`${inv.customer_name ?? 'Unknown customer'} — ${inv.ref_number ?? inv.id}`}
                    secondary={`Will send Notice ${nextNoticeSlot(inv)}`}
                  />
                </ListItem>
              ))}
            </List>
          </>
        )}
        {results && (
          <List dense disablePadding>
            {snapshot.map((inv) => {
              const r = results[String(inv.id)];
              const ok = r?.success;
              return (
                <ListItem key={inv.id} disableGutters>
                  <Box sx={{ mr: 1, display: 'flex', alignItems: 'center', color: ok ? 'success.main' : 'error.main' }}>
                    {ok ? <CheckCircleOutlineIcon fontSize="small" /> : <ErrorOutlineIcon fontSize="small" />}
                  </Box>
                  <ListItemText
                    primary={`${inv.customer_name ?? 'Unknown customer'} — ${inv.ref_number ?? inv.id}`}
                    secondary={ok ? `Notice ${r?.notice} emailed to ${r?.recipient}` : (r?.message ?? 'Already had all 3 notices sent')}
                  />
                </ListItem>
              );
            })}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        {!results ? (
          <>
            <Button onClick={onClose} disabled={sending}>Cancel</Button>
            <Button
              variant="contained"
              onClick={() => void handleSend()}
              disabled={sending || eligible.length === 0}
              startIcon={sending ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {sending ? 'Sending…' : `Send (${eligible.length})`}
            </Button>
          </>
        ) : (
          <Button variant="contained" onClick={onClose}>Done</Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default ArNoticeBulkEmailDialog;
