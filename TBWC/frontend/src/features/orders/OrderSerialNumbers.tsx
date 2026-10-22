import React from 'react';
import { Box, Button, Chip, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { OrderSerials } from '../../types/order';

/** QB dates arrive as plain 'YYYY-MM-DD' — format without a timezone shift. */
const shortDate = (d: string | null) => {
  if (!d) return null;
  const [y, m, day] = d.slice(0, 10).split('-');
  return y && m && day ? `${Number(m)}/${Number(day)}/${y.slice(2)}` : d;
};

/** The product blurb without the serial block staff appended to it — the first
 *  non-empty line is the product name in every row in the file. */
const productName = (desc: string | null) =>
  (desc ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';

interface OrderSerialNumbersProps {
  /** GET /api/orders/:id's parsed block; null when no invoice is linked yet. */
  value: OrderSerials | null | undefined;
}

/**
 * The order form's Serial Numbers tab: the serials QB holds for this order,
 * one row per invoice line that carries any.
 *
 * Nothing here is stored on the order — the serials are typed by hand into the
 * invoice line descriptions in QuickBooks and parsed back out on every read
 * (api/worker/routes/orderSerials.ts), so this is a read-only view of the
 * invoice, not a field. That is also why the source invoice is named in the
 * caption: when a serial looks wrong, that invoice in QuickBooks is where it
 * gets fixed.
 */
export const OrderSerialNumbers: React.FC<OrderSerialNumbersProps> = ({ value }) => {
  const items = value?.items ?? [];
  const serialCount = items.reduce((n, i) => n + i.serials.length, 0);
  const [copied, setCopied] = React.useState(false);

  // Flat list, one serial per line — the shape staff paste into an email or a
  // commissioning sheet. Clipboard access can be refused (insecure context,
  // permission denied), so a failure just leaves the button untouched.
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(items.flatMap((i) => i.serials).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* nothing to recover — the table is still on screen to read from */
    }
  };

  if (!value) {
    return (
      <Typography variant="body2" color="text.secondary">
        Not invoiced yet — serial numbers are read off the order's invoice.
      </Typography>
    );
  }

  const source = [
    value.invoice_ref ? `invoice ${value.invoice_ref}` : 'the linked invoice',
    shortDate(value.invoice_date),
  ].filter(Boolean).join(' · ');

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {serialCount === 0
            ? `No serial numbers typed on ${source}`
            : `${serialCount} serial number${serialCount === 1 ? '' : 's'} from ${source}`}
        </Typography>
        {serialCount > 0 && (
          <Tooltip title="Copy every serial number, one per line">
            <Button size="small" startIcon={<ContentCopyIcon fontSize="small" />} onClick={copyAll} sx={{ ml: 'auto' }}>
              {copied ? 'Copied' : 'Copy all'}
            </Button>
          </Tooltip>
        )}
      </Box>

      {serialCount === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Serial numbers are typed into the invoice's line descriptions in
          QuickBooks; none of this invoice's lines carry one.
        </Typography>
      ) : (
        <Table size="small" sx={{ '& td, & th': { verticalAlign: 'top' } }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '22%' }}>Item</TableCell>
              <TableCell sx={{ width: '38%' }}>Description</TableCell>
              <TableCell sx={{ width: '40%' }}>Serial Numbers</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((line, i) => (
              <TableRow key={`${line.item ?? ''}-${i}`} hover>
                <TableCell>
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{line.item || '—'}</Typography>
                </TableCell>
                {/* Full desc on hover: the serials sit inside it mixed with the
                    product blurb, so it's the only place to check a mis-parse. */}
                <TableCell>
                  <Tooltip title={<Box sx={{ whiteSpace: 'pre-wrap' }}>{line.desc ?? ''}</Box>} placement="top-start">
                    <Typography variant="body2" color="text.secondary">{productName(line.desc)}</Typography>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {line.serials.map((s) => (
                      <Chip key={s} label={s} size="small" variant="outlined" sx={{ fontFamily: 'monospace' }} />
                    ))}
                  </Box>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
};

export default OrderSerialNumbers;
