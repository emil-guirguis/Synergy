/**
 * Right-hand panel on the order form:
 *   - Packing Slips — linked invoices with total = 0; this company records a
 *                     packing slip in QB as a zero-total invoice, so both
 *                     arrive as invoices and are told apart by amount, not by
 *                     any QB type flag. Ahead of Invoices because it is what
 *                     gets looked up mid-build, before anything is billed.
 *   - Invoices      — linked invoices with total > 0, with invoiced/open money
 *                     summed under the rows it sums. Each invoice row lists
 *                     the QB ReceivePayment(s) applied to IT specifically
 *                     (GET /api/orders/:id/payments, one row per payment x
 *                     invoice pair) rather than in a Payments section of their
 *                     own — a payment reads as something that happened to an
 *                     invoice, not as a peer of it. Admin-only, like every
 *                     other money in this panel.
 *   - Totals footer — line-item count with the order total, and commission.
 *                     Pinned to the bottom of the panel (it belongs to the
 *                     order, not to either list) and read off the order record
 *                     the form already fetched, so no extra request. Money here
 *                     is admin-only, matching the rest of the rep view (rep
 *                     list/form and OrderLinesGrid all hide order money).
 *
 * Clicking a row opens that invoice in a modal stacked over the order form —
 * navigating to the invoices module instead would tear down the order form
 * (and any unsaved edit on it) just to read a linked document.
 *
 * Invoice rows come from GET /api/orders/:id/invoices in one call (see
 * orders.ts) and are split here rather than server-side, so the split rule
 * lives next to the UI that labels it. Rows are tied to the order by QB's own
 * LinkedTxn where present and by customer + PO number otherwise; a row badged
 * "shared PO" is one whose customer+PO sits on more than one order, so it may
 * belong to a different one — see that endpoint for the rest.
 *
 * Modelled on QuickBooks' own sales-order side panel (titled sections, hidden
 * with the chevron) — same information shape, MUI surfaces instead of the 2003
 * chrome. The whole panel collapses to a rail and each section collapses on its
 * own; both are per-viewer conveniences, so they persist in localStorage rather
 * than against the record.
 */
import { useEffect, useState } from 'react';
import {
  Box,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItemButton,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CalculateIcon from '@mui/icons-material/Calculate';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import PaymentsIcon from '@mui/icons-material/Payments';
import { ordersService } from './ordersStore';
import InvoiceForm from '../invoices/InvoiceForm';
import type { LinkedInvoice, LinkedPayment, Order } from '../../types/order';
import type { Invoice } from '../../types/invoice';

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);

/** QB dates arrive as plain 'YYYY-MM-DD' — format without a timezone shift. */
const shortDate = (d: string | null) => {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-');
  return y && m && day ? `${Number(m)}/${Number(day)}/${y.slice(2)}` : d;
};

const STORAGE_PREFIX = 'tbwc.orderPanel.';

/** Collapse state that survives a reload. Storage access itself can throw
 *  (private windows, blocked site data), so every read/write is guarded and
 *  falls back to the default. */
function useStickyToggle(key: string, initial: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? initial : raw === '1';
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(STORAGE_PREFIX + key, next ? '1' : '0');
    } catch {
      /* per-viewer convenience only — losing it changes nothing */
    }
  };
  return [value, set] as const;
}

interface OrderInvoicesPanelProps {
  orderId: string | number;
  /** The already-fetched order — the Totals section reads lines/total/commission
   *  off it rather than re-fetching what the form just loaded. */
  order?: Order;
  /** False for a rep: line-item count still shows, amounts don't. */
  showMoney?: boolean;
}

/** One label/value line in the Totals or Invoices summary blocks. Figures use
 *  the theme's primary (TBWC green) rather than a hand-picked accent, so they
 *  track the palette in tbwcTheme.ts. */
function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={600} color="primary.main">
        {value}
      </Typography>
    </Box>
  );
}

function SectionHeader({
  icon,
  title,
  count,
  expanded,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Box
      onClick={onToggle}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 2,
        py: 1.25,
        cursor: 'pointer',
        userSelect: 'none',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Box sx={{ color: 'text.disabled', display: 'flex' }}>{icon}</Box>
      <Typography
        variant="caption"
        sx={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary' }}
      >
        {title}
      </Typography>
      {count !== undefined && <Chip label={count} size="small" sx={{ height: 20, fontSize: 11 }} />}
      <ExpandMoreIcon
        fontSize="small"
        sx={{
          ml: 'auto',
          color: 'text.disabled',
          transform: expanded ? 'none' : 'rotate(-90deg)',
          transition: 'transform 150ms',
        }}
      />
    </Box>
  );
}

/** One payment applied against this invoice. Not clickable — a payment has
 *  no detail form of its own here (see the Payments module for that); amount
 *  is the slice of a possibly-split payment applied to THIS invoice, not the
 *  payment's full total. */
function PaymentRow({ payment }: { payment: LinkedPayment }) {
  const amount = Number(payment.amount) || 0;
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, pl: 3, pr: 2, py: 0.5 }}>
      <PaymentsIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
      <Typography variant="caption" color="text.secondary" noWrap>
        {payment.ref_number || `#${payment.qb_payment_id}`}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {currency(amount)}
      </Typography>
      <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto', whiteSpace: 'nowrap' }}>
        {shortDate(payment.txn_date)}
      </Typography>
    </Box>
  );
}

function InvoiceRow({
  invoice,
  showAmount,
  payments,
  onOpen,
}: {
  invoice: LinkedInvoice;
  showAmount: boolean;
  /** Payments applied to this specific invoice — see the file header. Empty
   *  for a packing slip (zero total, nothing to pay) and for any invoice
   *  synced before payment.ts started pulling AppliedToTxnRet. */
  payments: LinkedPayment[];
  onOpen: () => void;
}) {
  const balance = Number(invoice.balance_remaining) || 0;
  const total = Number(invoice.total) || 0;
  return (
    <Box sx={{ borderLeft: '2px solid transparent', '&:hover': { borderLeftColor: 'primary.main' } }}>
      <ListItemButton onClick={onOpen} sx={{ display: 'block', px: 2, py: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography variant="body2" fontWeight={600} noWrap>
            {invoice.ref_number || `#${invoice.qb_invoice_id}`}
          </Typography>
          {/* Only the ambiguous case is badged. Nearly every row is PO-matched
              until invoices re-pull with LinkedTxn, so badging plain 'po' would
              mark everything; a shared PO is the one that can be the wrong row. */}
          {invoice.matched_by === 'ambiguous' && (
            <Tooltip title="This customer + PO number appears on more than one order — check that this invoice belongs to this one">
              <Chip
                label="shared PO"
                size="small"
                color="warning"
                variant="outlined"
                sx={{ height: 18, fontSize: 10 }}
              />
            </Tooltip>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto', whiteSpace: 'nowrap' }}>
            {shortDate(invoice.txn_date)}
          </Typography>
        </Box>
        {showAmount && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {currency(total)}
            </Typography>
            <Chip
              size="small"
              label={invoice.is_paid || balance <= 0 ? 'Paid' : `${currency(balance)} open`}
              color={invoice.is_paid || balance <= 0 ? 'success' : 'warning'}
              variant="outlined"
              sx={{ ml: 'auto', height: 20, fontSize: 11 }}
            />
          </Box>
        )}
      </ListItemButton>
      {showAmount && payments.length > 0 && (
        <Box sx={{ pb: 0.5 }}>
          {payments.map((p) => (
            <PaymentRow key={`${p.qb_payment_id}-${p.qb_invoice_id}`} payment={p} />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default function OrderInvoicesPanel({ orderId, order, showMoney = true }: OrderInvoicesPanelProps) {
  const [items, setItems] = useState<LinkedInvoice[]>([]);
  const [payments, setPayments] = useState<LinkedPayment[]>([]);
  const [viewing, setViewing] = useState<LinkedInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useStickyToggle('open', true);
  const [slipsOpen, setSlipsOpen] = useStickyToggle('slips', true);
  const [invoicesOpen, setInvoicesOpen] = useStickyToggle('invoices', true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([ordersService.getLinkedInvoices(orderId), ordersService.getLinkedPayments(orderId)])
      .then(([invoiceRows, paymentRows]) => {
        if (!active) return;
        setItems(invoiceRows);
        setPayments(paymentRows);
      })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [orderId]);

  // total > 0 is an invoice; a zero-total linked invoice is a packing slip
  // (see the file header).
  const invoices = items.filter((i) => (Number(i.total) || 0) > 0);
  const packingSlips = items.filter((i) => (Number(i.total) || 0) <= 0);
  const invoiced = invoices.reduce((sum, i) => sum + (Number(i.total) || 0), 0);
  // Outstanding comes from QB's own balance_remaining on each invoice — the
  // authoritative figure QB already nets against every payment/credit/discount
  // applied to it — rather than being recomputed from the Payments list below.
  const openBalance = invoices.reduce((sum, i) => sum + (Number(i.balance_remaining) || 0), 0);
  const paid = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  // Admin-only, like every other money in this panel — a rep gets none of
  // these rows rather than relying on InvoiceRow's own showAmount (which
  // stays true for a rep so the invoice/paid chip still renders).
  const paymentsByInvoice = (invoiceId: number) =>
    showMoney ? payments.filter((p) => p.qb_invoice_id === invoiceId) : [];

  const lineCount = order?.lines?.length ?? 0;
  // commission_total is the Postgres GENERATED column (commission + overage) —
  // the same figure the Financials tab shows, not a recomputation.
  const commission = Number(order?.commission_total) || 0;
  // Denormalised from the linked invoice's FREIGHT line (orderInvoiceStatus.ts)
  // — QB's own order total never includes it, so without this row "Order
  // total" silently undercounts "Invoiced" by the freight amount whenever one
  // was added at invoicing time. Hidden when 0/null, same as OrderLinesGrid.
  const freight = Number(order?.freight) || 0;

  // The row we already hold, shaped as the Invoice the form expects. InvoiceForm
  // re-fetches by id on open and only falls back to this if that fetch fails —
  // which it does for a rep opening one of the ~350 invoices QB left without a
  // SalesRepRef (GET /api/invoices/:id scopes by rep and 404s). Passing the row
  // means the modal still shows number/date/amounts instead of an empty form.
  const asInvoice = (row: LinkedInvoice): Invoice => ({
    qb_invoice_id: row.qb_invoice_id,
    id: row.qb_invoice_id,
    txn_id: '',
    edit_sequence: null,
    ref_number: row.ref_number,
    customer_list_id: null,
    customer_name: order?.customer_name ?? null,
    txn_date: row.txn_date,
    due_date: row.due_date,
    subtotal: null,
    total: row.total,
    balance_remaining: row.balance_remaining,
    is_paid: row.is_paid,
    lines: null,
    linked_txn: null,
    time_modified: null,
    synced_at: null,
  });

  // Collapsed: a rail that keeps the two counts visible, so hiding the panel
  // doesn't hide whether this order has anything against it.
  const invoiceModal = (
    <Dialog
      open={!!viewing}
      onClose={() => setViewing(null)}
      // Hug the form instead of stretching: the invoice schema caps its form at
      // 900px (formMaxWidth), so a fullWidth/lg dialog left wide white gutters
      // on either side of it. fit-content sizes to whatever the form asks for,
      // capped so it can never outgrow the window.
      maxWidth={false}
      PaperProps={{ sx: { width: 'fit-content', maxWidth: '95vw', m: 2 } }}
      // Stacked over the order form's own modal — EntityManagementPage renders
      // that one, so this Dialog has to sit above it rather than replace it.
      sx={{ zIndex: (t) => t.zIndex.modal + 10 }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5, pl: 2, pr: 1 }}>
        Invoice {viewing?.ref_number || (viewing ? `#${viewing.qb_invoice_id}` : '')}
        <IconButton size="small" onClick={() => setViewing(null)} sx={{ ml: 'auto' }} aria-label="Close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      {/* No padding of its own — BaseForm brings its own surface and spacing. */}
      <DialogContent dividers sx={{ p: 0 }}>
        {viewing && <InvoiceForm invoice={asInvoice(viewing)} onCancel={() => setViewing(null)} />}
      </DialogContent>
    </Dialog>
  );

  if (!open) {
    return (
      <>
      {invoiceModal}
      <Paper
        variant="outlined"
        sx={{
          borderRadius: 2,
          alignSelf: 'flex-start',
          position: 'sticky',
          top: 0,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          py: 1,
          px: 0.5,
        }}
      >
        <Tooltip title="Show summary panel">
          <IconButton size="small" onClick={() => setOpen(true)}>
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {!loading && !error && (
          <>
            <Tooltip title={`${packingSlips.length} packing slip(s)`}>
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'text.secondary' }}>
                <LocalShippingIcon fontSize="small" />
                <Typography variant="caption">{packingSlips.length}</Typography>
              </Box>
            </Tooltip>
            <Tooltip title={`${invoices.length} invoice(s)`}>
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'text.secondary' }}>
                <ReceiptLongIcon fontSize="small" />
                <Typography variant="caption">{invoices.length}</Typography>
              </Box>
            </Tooltip>
          </>
        )}
      </Paper>
      </>
    );
  }

  return (
    <>
    {invoiceModal}
    <Paper
      variant="outlined"
      sx={{
        width: 300,
        flexShrink: 0,
        borderRadius: 2,
        alignSelf: 'flex-start',
        position: 'sticky',
        top: 0,
        maxHeight: 'calc(100vh - 220px)',
        overflowY: 'auto',
        bgcolor: 'background.paper',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          position: 'sticky',
          top: 0,
          bgcolor: 'background.paper',
          zIndex: 1,
        }}
      >
        <Typography variant="subtitle2" fontWeight={700}>
          Summary
        </Typography>
        <Tooltip title="Hide panel">
          <IconButton size="small" onClick={() => setOpen(false)} sx={{ ml: 'auto' }}>
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={22} />
        </Box>
      )}

      {!loading && error && (
        <Typography variant="body2" color="error" sx={{ px: 2, py: 2 }}>
          {error}
        </Typography>
      )}

      {!loading && !error && (
        <>
          <SectionHeader
            icon={<LocalShippingIcon fontSize="small" />}
            title="Packing Slips"
            count={packingSlips.length}
            expanded={slipsOpen}
            onToggle={() => setSlipsOpen(!slipsOpen)}
          />
          <Collapse in={slipsOpen} unmountOnExit>
            {packingSlips.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>
                None on this order.
              </Typography>
            ) : (
              <List disablePadding sx={{ pb: 1 }}>
                {packingSlips.map((slip) => (
                  <InvoiceRow
                    key={slip.qb_invoice_id}
                    invoice={slip}
                    showAmount={false}
                    payments={paymentsByInvoice(slip.qb_invoice_id)}
                    onOpen={() => setViewing(slip)}
                  />
                ))}
              </List>
            )}
          </Collapse>
          <Divider />

          <SectionHeader
            icon={<ReceiptLongIcon fontSize="small" />}
            title="Invoices"
            count={invoices.length}
            expanded={invoicesOpen}
            onToggle={() => setInvoicesOpen(!invoicesOpen)}
          />
          <Collapse in={invoicesOpen} unmountOnExit>
            {invoices.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 1.5 }}>
                Not invoiced yet.
              </Typography>
            ) : (
              <List disablePadding sx={{ pb: 1 }}>
                {invoices.map((inv) => (
                  <InvoiceRow
                    key={inv.qb_invoice_id}
                    invoice={inv}
                    showAmount
                    payments={paymentsByInvoice(inv.qb_invoice_id)}
                    onOpen={() => setViewing(inv)}
                  />
                ))}
              </List>
            )}
          </Collapse>

          {/* Order totals, pinned to the foot of the panel — sticky so they stay
              put while the lists above scroll. Off the order itself, not the
              linked invoices. */}
          <Box
            sx={{
              position: 'sticky',
              bottom: 0,
              px: 2,
              py: 1.25,
              display: 'grid',
              gap: 0.5,
              borderTop: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
              <CalculateIcon fontSize="small" sx={{ color: 'text.disabled' }} />
              <Typography
                variant="caption"
                sx={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary' }}
              >
                Totals
              </Typography>
            </Box>
            {/* Order total -> freight -> commission -> invoiced -> paid ->
                outstanding: the order's own money first, then what has
                actually been billed and collected against it. Freight is
                denormalised from the invoice (order.total never carries it —
                see the field's comment), so it's shown right under Order
                total: the two together are what Invoiced should reconcile to
                on a fully-invoiced order with no discounts. Invoiced/
                Outstanding sum the Invoices section above (packing slips
                carry no amount); Paid sums every payment row nested under
                those invoices. They live here so all the figures read as one
                running total rather than being split across the panel.
                Outstanding uses QB's own balance_remaining (see openBalance
                above), not Invoiced-minus-Paid, since QB already nets discounts
                and credits into it that a payments-only sum would miss.
                Rep view: the line count only — every amount is admin-only,
                matching the rep list/form and OrderLinesGrid. */}
            {showMoney ? (
              <>
                <SummaryLine label={`Order total (${lineCount} items)`} value={currency(Number(order?.total) || 0)} />
                {!!freight && <SummaryLine label="Freight" value={currency(freight)} />}
                <SummaryLine label="Commission" value={currency(commission)} />
                <SummaryLine label="Invoiced" value={currency(invoiced)} />
                <SummaryLine label="Paid" value={currency(paid)} />
                <SummaryLine label="Outstanding" value={currency(openBalance)} />
              </>
            ) : (
              <SummaryLine label="Line items" value={String(lineCount)} />
            )}
          </Box>
        </>
      )}
    </Paper>
    </>
  );
}
