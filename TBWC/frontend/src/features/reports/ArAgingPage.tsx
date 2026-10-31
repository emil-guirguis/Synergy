/**
 * AR Aging — how much of the receivable book is late, how long it has been
 * late, and the invoices themselves, on one screen.
 *
 * Four disjoint bands (1–30, 31–60, 61–90, over 90 days past due) as stat
 * tiles over a table of the past-due invoices behind them. Stat tiles rather
 * than a chart: five magnitudes with no time axis and no categories to compare
 * are a figure each. The bands start at 1 and leave no gap, so they sum to the
 * headline exactly.
 *
 * The tiles are *filters*, not links: clicking one narrows the table below to
 * that band and stays put, because the question after "how much is 90+ days
 * late" is always "which invoices" — and sending that click off to the
 * Invoices list would drop the aging context it was asked in. Clicking a row
 * opens the real module invoice form (this page wraps EntityManagementPage for
 * exactly that, so the AR tab, its Save button and the invoice:write gate are
 * the module's own, not a second implementation).
 *
 * Escalation is encoded by the MUI theme's own status tokens (success ->
 * warning -> warning.dark -> error), never by color alone: every tile carries
 * its band in the label and an icon beside it, so the ranking survives
 * greyscale, print and any CVD. The selected tile is outlined, not merely
 * tinted, for the same reason.
 *
 * Filters live in the URL so the browser's Back button restores them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
  Box,
  Card,
  CardActionArea,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Stack,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import ScheduleIcon from '@mui/icons-material/Schedule';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import { alpha } from '@mui/material/styles';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { formatCurrency, formatDate } from '@meterit/framework-frontend/utils';
import { arAgingService } from './arAgingService';
import { downloadArAgingCsv } from './arAgingExport';
import { ArNoticeBulkEmailDialog } from './ArNoticeBulkEmailDialog';
import { InvoiceForm } from '../invoices/InvoiceForm';
import { useAuth } from '../../hooks/useAuth';
import type { ArAgingBucket, ArAgingCustomer, ArAgingInvoice, ArAgingSummary } from '../../types/arAging';
import type { Invoice } from '../../types/invoice';

const currency = (n: number) => formatCurrency(n, { maximumFractionDigits: 0 });

const invoiceCount = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'invoice' : 'invoices'}`;

const ALL_CUSTOMERS = '';

/** Band identity in the URL: its minDays, or '' for "every past-due invoice". */
const bandKey = (bucket: ArAgingBucket | null) => (bucket ? String(bucket.minDays) : '');

// "1-30 Days Past Due" / "Over 90 Days Past Due" — the open-ended tail reads as
// "over <the previous band's end>", not "91+", which is right but nobody says it.
const bandLabel = ({ minDays, maxDays }: ArAgingBucket) =>
  maxDays === null ? `Over ${minDays - 1} Days Past Due` : `${minDays}-${maxDays} Days Past Due`;

const dateCell = (iso: string | null) => (iso ? formatDate(iso) : '');

type SortType = 'string' | 'number' | 'date' | 'boolean';
type SortDir = 'asc' | 'desc';

/**
 * One column's header label, alignment and how to pull a comparable value out
 * of a row. The table is built from this array rather than hand-duplicating
 * header cells and body cells — TableSortLabel wiring and the comparator below
 * both key off `field`, so a header can never go stale against the cell under it.
 */
const COLUMNS: {
  field: keyof ArAgingInvoice;
  label: string;
  align?: 'right' | 'center';
  type: SortType;
  minWidth?: number;
}[] = [
  { field: 'customer_name', label: 'Customer', type: 'string' },
  { field: 'balance_remaining', label: 'Amount Due', align: 'right', type: 'number' },
  { field: 'ref_number', label: 'Invoice #', type: 'string' },
  { field: 'txn_date', label: 'Invoice Sent', type: 'date' },
  { field: 'due_date', label: 'Invoice Due', type: 'date' },
  { field: 'notice_1_date', label: 'Notice #1', type: 'date' },
  { field: 'notice_2_date', label: 'Notice #2', type: 'date' },
  { field: 'notice_3_date', label: 'Notice #3', type: 'date' },
  { field: 'days_since_invoice', label: 'Days Since Invoice', align: 'right', type: 'number' },
  { field: 'days_past_due', label: 'Days Past Due', align: 'right', type: 'number' },
  { field: 'avg_days_to_pay', label: 'Average Days to Pay', align: 'right', type: 'number' },
  { field: 'late_fee_applied', label: 'Fee Applied', align: 'center', type: 'boolean' },
  { field: 'ar_notes', label: 'Notes', type: 'string', minWidth: 280 },
];

/**
 * Comparable value for one row's field — nulls sort last regardless of
 * direction (a blank "Notice #2" shouldn't jump to the top on ascending), and
 * every type reduces to a number or a lowercased string so `<`/`>` alone can
 * order it.
 */
function sortValue(row: ArAgingInvoice, field: keyof ArAgingInvoice, type: SortType): string | number {
  const v = row[field];
  if (v === null || v === undefined || v === '') return type === 'string' ? '￿' : Infinity;
  if (type === 'string') return String(v).toLowerCase();
  if (type === 'boolean') return v ? 1 : 0;
  if (type === 'date') return new Date(v as string).getTime();
  return Number(v);
}

/** One tile. `accent` is a theme status token, already resolved by the caller. */
function AgingTile({
  label,
  icon,
  accent,
  bucket,
  selected,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  accent?: string;
  bucket: ArAgingBucket;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Card
      variant="outlined"
      sx={{
        minWidth: 200,
        flex: 1,
        // Selection is a visible border plus the pressed state below, never
        // colour alone.
        borderColor: selected ? accent ?? 'text.primary' : undefined,
        borderWidth: selected ? 2 : 1,
      }}
    >
      <CardActionArea
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Show ${label} invoices`}
        sx={{ height: '100%' }}
      >
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5, color: accent ?? 'text.secondary' }}>
            {icon}
            <Typography variant="body2" color="text.secondary">{label}</Typography>
          </Stack>
          <Typography variant="h4" fontWeight={700} sx={{ color: accent ?? 'text.primary' }}>
            {currency(bucket.total)}
          </Typography>
          <Typography variant="body2" color="text.secondary">{invoiceCount(bucket.count)}</Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

/** The tiles, the filters and the table. Rendered as EntityManagementPage's list. */
function ArAgingReport({ onInvoiceOpen }: { onInvoiceOpen: (invoice: Invoice) => void }) {
  const theme = useTheme();
  const { scopeOf } = useAuth();
  // Same gate the invoice form's own AR tab answers to — a caller who can't
  // save an AR edit has no use for a button whose whole job is to send one.
  const canEditAr = scopeOf('invoice:write') !== null;
  const [searchParams, setSearchParams] = useSearchParams();
  const customerListId = searchParams.get('customerListId') || ALL_CUSTOMERS;
  const band = searchParams.get('band') || '';

  const [summary, setSummary] = useState<ArAgingSummary | null>(null);
  const [rows, setRows] = useState<ArAgingInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Row checkboxes for the bulk "Email" action below. `refreshKey` is bumped
  // after a bulk send so the rows effect refetches (the sent notices' dates
  // are now set) without duplicating its fetch logic here.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value); else next.delete(key);
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  // The band the table is showing: the selected tile's bounds, or the headline
  // (every past-due invoice) when nothing is selected.
  const selectedBucket = useMemo(
    () => summary?.buckets.find((b) => String(b.minDays) === band) ?? null,
    [summary, band]
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    arAgingService
      .getSummary(customerListId || null)
      .then((res) => { if (active) setSummary(res); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Failed to load report'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [customerListId]);

  useEffect(() => {
    let active = true;
    setRowsLoading(true);
    // Any refetch invalidates whatever was checked — a stale id could still
    // match a different row after a reload, and a bulk send specifically
    // changes the very rows it was run on (see handleBulkEmailSent below).
    setSelected(new Set());
    // `band` rather than selectedBucket: the bounds are derivable from the
    // band key alone once the summary has loaded, and keying the effect on the
    // object would refetch every time the summary reloads.
    const bucket = summary?.buckets.find((b) => String(b.minDays) === band) ?? null;
    arAgingService
      .getInvoices(customerListId || null, bucket?.minDays ?? null, bucket?.maxDays ?? null)
      .then((res) => { if (active) setRows(res); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Failed to load invoices'); })
      .finally(() => { if (active) setRowsLoading(false); });
    return () => { active = false; };
  }, [customerListId, band, summary, refreshKey]);

  // Client-side: the table already holds the full result for the current
  // filter (ROW_LIMIT caps it at 1000 server-side), so a second round trip
  // just to reorder what's already on screen would be wasted latency.
  const [sortField, setSortField] = useState<keyof ArAgingInvoice>('days_past_due');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const handleSort = (field: keyof ArAgingInvoice) => {
    if (field === sortField) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortedRows = useMemo(() => {
    const column = COLUMNS.find((c) => c.field === sortField);
    const type = column?.type ?? 'string';
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sortField, type);
      const bv = sortValue(b, sortField, type);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sortField, sortDir]);

  // Keyed by position, not by the band's bounds, so re-cutting the bands
  // server-side doesn't silently drop every tile back to the default styling.
  const STYLES = [
    { icon: <EventAvailableIcon fontSize="small" />, accent: theme.palette.success.main },
    { icon: <ScheduleIcon fontSize="small" />, accent: theme.palette.warning.main },
    { icon: <WarningAmberIcon fontSize="small" />, accent: theme.palette.warning.dark },
    { icon: <ErrorOutlineIcon fontSize="small" />, accent: theme.palette.error.main },
  ];

  const toggleSelected = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const allSelected = sortedRows.length > 0 && sortedRows.every((r) => selected.has(r.id));
  const someSelected = sortedRows.some((r) => selected.has(r.id));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(sortedRows.map((r) => r.id)));

  // Bumping refreshKey re-runs the rows effect (and clears selection there)
  // so the just-sent notices' dates/locks show up without re-deriving the
  // fetch here.
  const handleBulkEmailSent = () => setRefreshKey((k) => k + 1);

  const selectedInvoices = sortedRows.filter((r) => selected.has(r.id));

  const selectedCustomer: ArAgingCustomer | null =
    summary?.customers.find((c) => c.list_id === customerListId) ?? null;

  // Clicking the selected tile again clears the filter — a toggle, so there's
  // always a way back to "everything" without hunting for a reset control.
  const toggleBand = (bucket: ArAgingBucket | null) =>
    updateParams({ band: bandKey(bucket) === band ? null : bandKey(bucket) });

  const tableCaption = selectedBucket
    ? bandLabel(selectedBucket)
    : 'All past-due invoices';

  return (
    <Box data-testid="ar-aging-page" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={2}>
        <Typography variant="h5">AR Aging</Typography>
        <Autocomplete
          size="small"
          options={summary?.customers ?? []}
          getOptionLabel={(option) => option.name ?? ''}
          isOptionEqualToValue={(option, value) => option.list_id === value.list_id}
          value={selectedCustomer}
          onChange={(_e, option) => updateParams({ customerListId: option?.list_id ?? null })}
          sx={{ minWidth: 300, maxWidth: 460 }}
          renderInput={(params) => <TextField {...params} label="Customer" placeholder="All customers" />}
        />
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && !summary && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {summary && (
        <Stack spacing={3}>
          <Stack direction="row" flexWrap="wrap" gap={2}>
            {summary.buckets.map((bucket, i) => {
              const style = STYLES[i] ?? STYLES[STYLES.length - 1];
              return (
                <AgingTile
                  key={bucket.minDays}
                  label={bandLabel(bucket)}
                  icon={style.icon}
                  accent={style.accent}
                  bucket={bucket}
                  selected={String(bucket.minDays) === band}
                  onSelect={() => toggleBand(bucket)}
                />
              );
            })}
            {/* Last, not first: the four bands are what someone scans across
                first ("where does the money sit"), and the total is the sum
                they already add up to — a recap, not the headline. */}
            <AgingTile
              label="Total Past Due"
              icon={<RequestQuoteIcon fontSize="small" />}
              bucket={summary.pastDue}
              selected={!band}
              onSelect={() => updateParams({ band: null })}
            />
          </Stack>

          <Box>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="h6">{tableCaption}</Typography>
              <Chip size="small" label={invoiceCount(rows.length)} />
              {selectedCustomer && <Chip size="small" label={selectedCustomer.name} />}
              {rowsLoading && <CircularProgress size={16} />}
              {someSelected && <Chip size="small" color="primary" label={`${selected.size} selected`} />}
              <Box sx={{ flexGrow: 1 }} />
              {canEditAr && (
                <Button
                  size="small"
                  startIcon={<EmailOutlinedIcon fontSize="small" />}
                  disabled={!someSelected}
                  onClick={() => setEmailDialogOpen(true)}
                >
                  Email
                </Button>
              )}
              <Button
                size="small"
                startIcon={<FileDownloadIcon fontSize="small" />}
                disabled={sortedRows.length === 0}
                onClick={() => downloadArAgingCsv(sortedRows, tableCaption)}
              >
                Download
              </Button>
            </Stack>

            <TableContainer sx={{ maxHeight: 640, overflowX: 'auto' }}>
              <Table
                size="small"
                stickyHeader
                sx={{
                  // Zebra striping, scoped to this report's table only — a flat
                  // tint rather than reusing action.hover (that's still the
                  // row's :hover state below, and stacking the two gives every
                  // other row a visibly stronger hover than its neighbors).
                  // alpha() over the theme's own text color rather than a fixed
                  // gray so the stripe stays correct in both light and dark.
                  '& tbody tr:nth-of-type(even)': {
                    backgroundColor: (theme) => alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.06 : 0.04),
                  },
                }}
              >
                <TableHead>
                  <TableRow>
                    {canEditAr && (
                      <TableCell padding="checkbox">
                        <Checkbox
                          size="small"
                          checked={allSelected}
                          indeterminate={someSelected && !allSelected}
                          onChange={toggleSelectAll}
                          inputProps={{ 'aria-label': 'Select all invoices' }}
                        />
                      </TableCell>
                    )}
                    {/* whiteSpace: 'nowrap' on every header — the table already scrolls
                        horizontally (TableContainer above), so a wrapped header just
                        costs row height for no benefit. */}
                    {COLUMNS.map((col) => (
                      <TableCell
                        key={col.field}
                        align={col.align}
                        sortDirection={sortField === col.field ? sortDir : false}
                        sx={{ whiteSpace: 'nowrap', minWidth: col.minWidth }}
                      >
                        <TableSortLabel
                          active={sortField === col.field}
                          direction={sortField === col.field ? sortDir : 'asc'}
                          onClick={() => handleSort(col.field)}
                        >
                          {col.label}
                        </TableSortLabel>
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sortedRows.map((row) => (
                    <TableRow
                      key={row.id}
                      hover
                      // The whole row opens the invoice; the form itself is the
                      // module's, so everything editable there stays gated on
                      // invoice:write.
                      onClick={() => onInvoiceOpen({ ...(row as unknown as Invoice), id: row.id })}
                      sx={{ cursor: 'pointer' }}
                    >
                      {canEditAr && (
                        <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            size="small"
                            checked={selected.has(row.id)}
                            onChange={() => toggleSelected(row.id)}
                            inputProps={{ 'aria-label': `Select invoice ${row.ref_number ?? row.id}` }}
                          />
                        </TableCell>
                      )}
                      <TableCell>{row.customer_name}</TableCell>
                      <TableCell align="right">{formatCurrency(row.balance_remaining as any)}</TableCell>
                      <TableCell>{row.ref_number}</TableCell>
                      <TableCell>{dateCell(row.txn_date)}</TableCell>
                      <TableCell>{dateCell(row.due_date)}</TableCell>
                      <TableCell>{dateCell(row.notice_1_date)}</TableCell>
                      <TableCell>{dateCell(row.notice_2_date)}</TableCell>
                      <TableCell>{dateCell(row.notice_3_date)}</TableCell>
                      <TableCell align="right">{row.days_since_invoice ?? ''}</TableCell>
                      <TableCell align="right">{row.days_past_due ?? ''}</TableCell>
                      <TableCell align="right">{row.avg_days_to_pay ?? ''}</TableCell>
                      <TableCell align="center">{row.late_fee_applied ? 'Y' : ''}</TableCell>
                      <TableCell sx={{ whiteSpace: 'pre-wrap' }}>{row.ar_notes}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && !rowsLoading && (
                    <TableRow>
                      <TableCell colSpan={COLUMNS.length + (canEditAr ? 1 : 0)}>
                        <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                          Nothing past due for this selection.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </Stack>
      )}
      {canEditAr && (
        <ArNoticeBulkEmailDialog
          open={emailDialogOpen}
          onClose={() => setEmailDialogOpen(false)}
          invoices={selectedInvoices}
          onSent={handleBulkEmailSent}
        />
      )}
    </Box>
  );
}

export default function ArAgingPage() {
  const { scopeOf } = useAuth();
  // Same gate the Invoices module applies: without invoice:write the form that
  // opens from a row is a viewer (see InvoiceManagementPage).
  const canEditAr = scopeOf('invoice:write') !== null;

  return (
    <EntityManagementPage<Invoice>
      title="Invoice"
      moduleIcon="invoices"
      modalSize="lg"
      showSaveButton={canEditAr}
      editLabel={(entity) =>
        `${canEditAr ? 'Invoice' : 'View Invoice'} ${entity?.ref_number ?? ''}`.trim()}
      renderList={({ onEdit }) => <ArAgingReport onInvoiceOpen={onEdit} />}
      renderForm={({ entity, onCancel }) => <InvoiceForm invoice={entity} onCancel={onCancel} />}
    />
  );
}
