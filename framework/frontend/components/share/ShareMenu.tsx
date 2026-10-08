import React, { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Autocomplete,
  CircularProgress,
  Typography,
} from '@mui/material';

export interface SharePerson {
  id: string;
  label: string;
}

export interface ShareMenuProps {
  open: boolean;
  onClose: () => void;
  /** What's being shared — shown in the dialog title and link preview. */
  title: string;
  /** Deep link to the shared record. Shown as a preview; the caller's
   *  `onShare` closes over it to attach it to the notification. */
  url: string;
  searchPeople: (query: string) => Promise<SharePerson[]>;
  onShare: (params: { recipient: SharePerson; note: string }) => Promise<void>;
}

/**
 * "Share this with a colleague" dialog — pick a person (debounced search via
 * the app-supplied `searchPeople`), add an optional note, send. The app wires
 * `onShare` to its own notification-create call, closing over `url`.
 */
export const ShareMenu: React.FC<ShareMenuProps> = ({ open, onClose, title, url, searchPeople, onShare }) => {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SharePerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [recipient, setRecipient] = useState<SharePerson | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setOptions([]);
    setRecipient(null);
    setNote('');
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      searchPeople(query)
        .then(setOptions)
        .catch(() => setOptions([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  const handleSend = async () => {
    if (!recipient) return;
    setSending(true);
    setError(null);
    try {
      await onShare({ recipient, note });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to share');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={sending ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Share "{title}"</DialogTitle>
      <DialogContent>
        {error && (
          <Typography variant="body2" color="error" sx={{ mb: 1.5 }}>
            {error}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2, wordBreak: 'break-all' }}>
          {url}
        </Typography>
        <Autocomplete
          options={options}
          getOptionLabel={(o) => o.label}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          loading={loading}
          value={recipient}
          onChange={(_e, val) => setRecipient(val)}
          onInputChange={(_e, val) => setQuery(val)}
          disabled={sending}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Share with"
              placeholder="Search by name…"
              autoFocus
              InputProps={{
                ...params.InputProps,
                endAdornment: (
                  <>
                    {loading ? <CircularProgress size={16} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ),
              }}
            />
          )}
          sx={{ mb: 2 }}
        />
        <TextField
          label="Note (optional)"
          multiline
          minRows={2}
          fullWidth
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={sending}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button onClick={handleSend} variant="contained" disabled={!recipient || sending}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ShareMenu;
