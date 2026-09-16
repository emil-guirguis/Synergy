/**
 * Invoice Totals report — admin dashboard: total invoiced this year-to-date
 * vs. the same period last year, filterable to one sales rep or all reps.
 * Year and rep dropdowns both drive one GET /reports/invoice-totals/summary
 * fetch (see invoiceTotals.ts for the same-day-of-year YTD comparison).
 */
import { useEffect, useState } from 'react';
import { Alert, Box, Card, CardContent, CircularProgress, MenuItem, Select, Stack, Typography } from '@mui/material';
import { invoiceTotalsService } from './invoiceTotalsService';
import type { InvoiceTotalsSummary } from '../../types/invoiceTotals';

const CURRENT_YEAR = new Date().getFullYear();
const ALL_REPS = '';

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

function pctChange(current: number, prior: number): string {
  if (prior === 0) return current === 0 ? '—' : '+∞%';
  const pct = ((current - prior) / prior) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function TotalCard({ label, period, sub }: { label: string; period: { total: number; count: number }; sub?: string }) {
  return (
    <Card variant="outlined" sx={{ minWidth: 220, flex: 1 }}>
      <CardContent>
        <Typography variant="body2" color="text.secondary">{label}</Typography>
        <Typography variant="h4" fontWeight={700}>{currency(period.total)}</Typography>
        <Typography variant="body2" color="text.secondary">
          {period.count.toLocaleString()} {period.count === 1 ? 'invoice' : 'invoices'}
          {sub ? ` · ${sub}` : ''}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default function InvoiceTotalsPage() {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [years, setYears] = useState<number[]>([CURRENT_YEAR]);
  const [repId, setRepId] = useState<string>(ALL_REPS);
  const [summary, setSummary] = useState<InvoiceTotalsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    invoiceTotalsService
      .getSummary(year, repId || null)
      .then((res) => {
        if (!active) return;
        setSummary(res);
        if (res.years?.length) setYears(res.years);
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Failed to load report'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [year, repId]);

  return (
    <Box data-testid="invoice-totals-page" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={2}>
        <Typography variant="h5">Invoice Totals: YTD vs. Last Year</Typography>
        <Stack direction="row" spacing={2}>
          <Select size="small" value={repId} onChange={(e) => setRepId(e.target.value)} sx={{ minWidth: 180 }}>
            <MenuItem value={ALL_REPS}>All Reps</MenuItem>
            {summary?.reps.map((rep) => (
              <MenuItem key={rep.list_id} value={rep.list_id}>{rep.name}</MenuItem>
            ))}
          </Select>
          <Select size="small" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <MenuItem key={y} value={y}>{y}</MenuItem>
            ))}
          </Select>
        </Stack>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && !summary && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {summary && (
        <Stack spacing={2}>
          <Stack direction="row" spacing={2} flexWrap="wrap">
            <TotalCard label={`${year} (Year-to-Date)`} period={summary.current} />
            <TotalCard label={`${year - 1} (Same Period)`} period={summary.prior} />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Change vs. last year: {pctChange(summary.current.total, summary.prior.total)}
            {repId && summary.reps.find((r) => r.list_id === repId)
              ? ` · Filtered to ${summary.reps.find((r) => r.list_id === repId)?.name}`
              : ' · All reps'}
          </Typography>
        </Stack>
      )}
    </Box>
  );
}
