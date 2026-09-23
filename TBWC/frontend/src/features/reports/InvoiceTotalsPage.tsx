/**
 * Invoice Totals Analysis — admin dashboard: current-period-to-date vs. the
 * same period last year, plus a trend line. One granularity filter
 * (week/month/quarter/year) drives both the top totals and the chart below —
 * there's no year picker; "current" is always anchored to today, and
 * choosing Yearly is how you get the old YTD-vs-last-year-YTD view (see
 * invoiceTotals.ts's periodWindows for the current/prior date math).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip as MuiTooltip,
  Typography,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { invoiceTotalsService, type CustomRange } from './invoiceTotalsService';
import { downloadTrendCsv } from './invoiceTotalsExport';
import type { InvoiceTotalsGranularity, InvoiceTotalsPeriod, InvoiceTotalsSummary, InvoiceTotalsTrend } from '../../types/invoiceTotals';

// dataviz skill palette (references/palette.md) — light-surface tokens, single line series.
const CHART_LINE = '#2a78d6';
const CHART_GRID = '#e1e0d9';
const CHART_AXIS = '#c3c2b7';
const CHART_MUTED = '#898781';
const CHART_INK = '#0b0b0b';

const PERIOD_LABELS: Record<InvoiceTotalsGranularity, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  quarter: 'Quarterly',
  year: 'Yearly',
  custom: 'Custom',
};

const CURRENT_LABELS: Record<InvoiceTotalsGranularity, string> = {
  day: 'Today',
  week: 'This Week (Fri–Thu)',
  month: 'This Month',
  quarter: 'This Quarter',
  year: 'This Year (YTD)',
  custom: 'Selected Range',
};

// For period="year" this equals PRIOR_YEAR_LABELS.year — "one period back"
// and "same period last year" are the same window at yearly granularity.
const PREVIOUS_LABELS: Record<InvoiceTotalsGranularity, string> = {
  day: 'Yesterday',
  week: 'Last Week (Fri–Thu)',
  month: 'Last Month',
  quarter: 'Last Quarter',
  year: 'Last Year (YTD)',
  custom: 'Previous Range',
};

const PRIOR_YEAR_LABELS: Record<InvoiceTotalsGranularity, string> = {
  day: 'Same Day, Last Year',
  week: 'Same Week, Last Year',
  month: 'Same Month, Last Year',
  quarter: 'Same Quarter, Last Year',
  year: 'Last Year (YTD)',
  custom: 'Same Range, Last Year',
};

function quarterLabel(d: Date): string {
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

function formatBucketLabel(iso: string, period: InvoiceTotalsGranularity): string {
  // bucketStart comes back either as a bare "yyyy-mm-dd" or, once
  // node-postgres's DATE parser (which builds the JS Date at local-timezone
  // midnight) round-trips through JSON.stringify, a full ISO datetime like
  // "...T08:00:00.000Z" — the date component is unaffected either way, and
  // both forms parse correctly as-is; appending a second "T00:00:00Z" onto
  // the datetime form breaks Date parsing.
  const d = new Date(iso);
  if (period === 'quarter') return quarterLabel(d);
  const opts: Intl.DateTimeFormatOptions =
    period === 'day' || period === 'week' || period === 'custom'
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : period === 'month'
        ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
        : { year: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

const ALL_REPS = '';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultCustomRange(): CustomRange {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86400000);
  return { from: isoDate(from), to: isoDate(to) };
}

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

function pctChange(current: number, prior: number): string {
  if (prior === 0) return current === 0 ? '—' : '+∞%';
  const pct = ((current - prior) / prior) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// The open icon takes you to the Invoices list filtered to the exact date
// range (and rep) that produced this card's total — invoices.ts's whereRange
// reads txn_date_from/txn_date_to, InvoiceList.tsx picks them off the URL.
function TotalCard({ label, period, onOpen }: { label: string; period: InvoiceTotalsPeriod; onOpen: () => void }) {
  return (
    <Card variant="outlined" sx={{ minWidth: 220, flex: 1 }}>
      <CardContent sx={{ position: 'relative' }}>
        <MuiTooltip title="Open these invoices">
          <IconButton
            size="small"
            onClick={onOpen}
            aria-label={`Open ${label} invoices`}
            sx={{ position: 'absolute', top: 4, right: 4 }}
          >
            <OpenInNewIcon fontSize="small" />
          </IconButton>
        </MuiTooltip>
        <Typography variant="body2" color="text.secondary">{label}</Typography>
        <Typography variant="h4" fontWeight={700}>{currency(period.total)}</Typography>
        <Typography variant="body2" color="text.secondary">
          {period.count.toLocaleString()} {period.count === 1 ? 'invoice' : 'invoices'}
        </Typography>
      </CardContent>
    </Card>
  );
}

const VALID_PERIODS = new Set<InvoiceTotalsGranularity>(['day', 'week', 'month', 'quarter', 'year', 'custom']);

export default function InvoiceTotalsPage() {
  const navigate = useNavigate();
  // Filters live in the URL (not component state) so the browser's own Back
  // button restores them — clicking a card's open icon pushes /invoices onto
  // history; Back then lands here on the exact URL your filters last wrote.
  const [searchParams, setSearchParams] = useSearchParams();

  const periodParam = searchParams.get('period');
  const period: InvoiceTotalsGranularity =
    periodParam && VALID_PERIODS.has(periodParam as InvoiceTotalsGranularity)
      ? (periodParam as InvoiceTotalsGranularity)
      : 'week';
  const repId = searchParams.get('repId') || ALL_REPS;
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  const customRange = useMemo<CustomRange>(
    () => (fromParam && toParam ? { from: fromParam, to: toParam } : defaultCustomRange()),
    [fromParam, toParam]
  );

  function updateParams(patch: Record<string, string | null>) {
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
  }

  const setPeriod = (p: InvoiceTotalsGranularity) => updateParams({ period: p });
  const setRepId = (id: string) => updateParams({ repId: id || null });
  const setCustomFrom = (from: string) => updateParams({ from, to: toParam ?? customRange.to });
  const setCustomTo = (to: string) => updateParams({ to, from: fromParam ?? customRange.from });

  const [summary, setSummary] = useState<InvoiceTotalsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [trend, setTrend] = useState<InvoiceTotalsTrend | null>(null);
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendError, setTrendError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    invoiceTotalsService
      .getSummary(period, repId || null, customRange)
      .then((res) => { if (active) setSummary(res); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Failed to load report'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, repId, customRange]);

  useEffect(() => {
    let active = true;
    setTrendLoading(true);
    setTrendError(null);
    invoiceTotalsService
      .getTrend(period, repId || null, customRange)
      .then((res) => { if (active) setTrend(res); })
      .catch((err) => { if (active) setTrendError(err instanceof Error ? err.message : 'Failed to load trend'); })
      .finally(() => { if (active) setTrendLoading(false); });
    return () => { active = false; };
  }, [period, repId, customRange]);

  const chartData = (trend?.points ?? []).map((p) => ({
    label: formatBucketLabel(p.bucketStart, trend!.period),
    total: p.total,
    count: p.count,
  }));

  const repLabel = (repId && summary?.reps.find((r) => r.list_id === repId)?.name) || 'All Reps';

  function openInvoices(card: InvoiceTotalsPeriod) {
    const q = new URLSearchParams({ txn_date_from: card.from, txn_date_to: card.to });
    if (repId) q.set('sales_rep_list_id', repId);
    navigate(`/invoices?${q.toString()}`);
  }

  return (
    <Box data-testid="invoice-totals-page" sx={{ p: 2 }}>
      <style>{
        '@media print { .no-print, .app-header, .sidebar, .breadcrumb { display: none !important; } ' +
        '.app-layout__main { margin: 0 !important; padding: 0 !important; } }'
      }</style>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={2}>
        <Typography variant="h5">Invoice Totals Analysis</Typography>
        <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center" className="no-print">
          <Select
            size="small"
            displayEmpty
            value={repId}
            onChange={(e) => setRepId(e.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value={ALL_REPS}>All Reps</MenuItem>
            {summary?.reps.map((rep) => (
              <MenuItem key={rep.list_id} value={rep.list_id}>{rep.name}</MenuItem>
            ))}
          </Select>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={period}
            onChange={(_e, val) => val && setPeriod(val)}
          >
            <ToggleButton value="day">Daily</ToggleButton>
            <ToggleButton value="week">Weekly</ToggleButton>
            <ToggleButton value="month">Monthly</ToggleButton>
            <ToggleButton value="quarter">Quarterly</ToggleButton>
            <ToggleButton value="year">Yearly</ToggleButton>
            <ToggleButton value="custom">Custom</ToggleButton>
          </ToggleButtonGroup>
          {period === 'custom' && (
            <>
              <TextField
                size="small"
                type="date"
                label="From"
                slotProps={{ inputLabel: { shrink: true } }}
                value={customRange.from}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <TextField
                size="small"
                type="date"
                label="To"
                slotProps={{ inputLabel: { shrink: true } }}
                value={customRange.to}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </>
          )}
          <Button
            size="small"
            variant="outlined"
            startIcon={<DownloadIcon />}
            disabled={!trend || chartData.length === 0}
            onClick={() => trend && downloadTrendCsv(trend, repLabel)}
          >
            Export to Excel
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<PictureAsPdfIcon />}
            onClick={() => window.print()}
          >
            Preview PDF
          </Button>
        </Stack>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && !summary && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {summary && (
        <Stack spacing={2}>
          <Stack direction="row" spacing={2} flexWrap="wrap">
            <TotalCard label={CURRENT_LABELS[period]} period={summary.current} onOpen={() => openInvoices(summary.current)} />
            <TotalCard label={PREVIOUS_LABELS[period]} period={summary.previous} onOpen={() => openInvoices(summary.previous)} />
            <TotalCard label={PRIOR_YEAR_LABELS[period]} period={summary.priorYear} onOpen={() => openInvoices(summary.priorYear)} />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Change vs. last period: {pctChange(summary.current.total, summary.previous.total)}
            {' · '}Change vs. last year: {pctChange(summary.current.total, summary.priorYear.total)}
            {repId && summary.reps.find((r) => r.list_id === repId)
              ? ` · Filtered to ${summary.reps.find((r) => r.list_id === repId)?.name}`
              : ' · All reps'}
          </Typography>
        </Stack>
      )}

      <Card variant="outlined" sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Invoice Total Trend — {PERIOD_LABELS[period]}
            {period === 'week' ? ' (Friday–Friday)' : ''}
            {period === 'custom' ? ` (${customRange.from} – ${customRange.to})` : ''}
          </Typography>

          {trendError && <Alert severity="error" sx={{ mb: 2 }}>{trendError}</Alert>}

          {trendLoading && !trend && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          )}

          {trend && chartData.length === 0 && !trendLoading && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
              No invoice data for this period.
            </Typography>
          )}

          {trend && chartData.length > 0 && (
            <Box sx={{ width: '100%', height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                  <CartesianGrid stroke={CHART_GRID} vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke={CHART_AXIS}
                    tick={{ fill: CHART_MUTED, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: CHART_AXIS }}
                    minTickGap={24}
                  />
                  <YAxis
                    stroke={CHART_AXIS}
                    tick={{ fill: CHART_MUTED, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => currency(v)}
                    width={80}
                  />
                  <Tooltip
                    cursor={{ stroke: CHART_AXIS, strokeWidth: 1 }}
                    contentStyle={{ borderColor: CHART_GRID, fontSize: 13 }}
                    labelStyle={{ color: CHART_INK, fontWeight: 600 }}
                    formatter={(value: number, _name, item) => [
                      `${currency(value)} · ${item.payload.count.toLocaleString()} invoice${item.payload.count === 1 ? '' : 's'}`,
                      'Total',
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="total"
                    name="Total"
                    stroke={CHART_LINE}
                    strokeWidth={2}
                    dot={chartData.length <= 40}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
