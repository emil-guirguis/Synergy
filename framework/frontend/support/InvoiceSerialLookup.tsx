import React, { useEffect, useRef, useState } from 'react';
import { Box, Chip, CircularProgress, Link, List, ListItem, Typography } from '@mui/material';
import type { InvoiceSerialMatch } from './types';

export interface InvoiceSerialLookupProps {
  serial?: string | null;
  lookup: (serial: string) => Promise<InvoiceSerialMatch[]>;
  /** Where an invoice's row links to. Defaults to the TBWC invoice-list "open one row" convention. */
  invoiceHref?: (match: InvoiceSerialMatch) => string;
}

const DEFAULT_HREF = (m: InvoiceSerialMatch) => `/invoices?openId=${m.qb_invoice_id}`;

/**
 * Debounced "which invoices mention this serial number" lookup, shown right
 * under the ticket form's Serial Number field. Invoices have no structured
 * serial column (hand-typed into a line's description — see TBWC's
 * routes/support.ts invoices-by-serial), so this is always a substring search
 * against free text and may turn up more than one invoice.
 */
export const InvoiceSerialLookup: React.FC<InvoiceSerialLookupProps> = ({ serial, lookup, invoiceHref = DEFAULT_HREF }) => {
  const [loading, setLoading] = useState(false);
  const [matches, setMatches] = useState<InvoiceSerialMatch[]>([]);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const trimmed = serial?.trim() ?? '';
    if (trimmed.length < 3) {
      setMatches([]);
      setSearched(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      lookup(trimmed)
        .then(r => setMatches(r))
        .catch(() => setMatches([]))
        .finally(() => { setLoading(false); setSearched(true); });
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [serial, lookup]);

  if (!serial || serial.trim().length < 3) return null;

  return (
    <Box mt={1} mb={1}>
      {loading && (
        <Box display="flex" alignItems="center" gap={1}>
          <CircularProgress size={14} />
          <Typography variant="caption" color="text.secondary">Searching invoices…</Typography>
        </Box>
      )}
      {!loading && searched && matches.length === 0 && (
        <Typography variant="caption" color="text.secondary">No invoices mention this serial number.</Typography>
      )}
      {!loading && matches.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary">
            Found on {matches.length} invoice{matches.length === 1 ? '' : 's'}:
          </Typography>
          <List dense disablePadding>
            {matches.map(m => (
              <ListItem key={m.qb_invoice_id} disableGutters sx={{ display: 'block', py: 0.25 }}>
                <Box display="flex" alignItems="baseline" gap={1} flexWrap="wrap">
                  <Link href={invoiceHref(m)} target="_blank" rel="noopener" underline="hover">
                    {m.invoice_number ?? `#${m.qb_invoice_id}`}
                  </Link>
                  {m.txn_date && <Chip size="small" variant="outlined" label={new Date(m.txn_date).toLocaleDateString()} />}
                </Box>
                {m.description && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {m.description}
                  </Typography>
                )}
              </ListItem>
            ))}
          </List>
        </>
      )}
    </Box>
  );
};

export default InvoiceSerialLookup;
