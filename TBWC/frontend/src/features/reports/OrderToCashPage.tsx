/**
 * Order-to-Cash (Bottleneck Finder) — admin/employee-only. Where cash is
 * stuck: total value of orders not yet billed, the oldest of those orders by
 * name, and how long paid invoices actually take to collect. Defaults to
 * "All" (every year, the original no-filter view) with a per-year option.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Box, Card, CardContent, Chip, CircularProgress, Select, MenuItem, Stack, Typography,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper,
} from '@mui/material';
import { orderToCashService } from './orderToCashService';
import type { OrderToCashSummary, UninvoicedOrder } from '../../types/orderToCash';

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US');
}

function daysOpenColor(days: number | null): 'default' | 'warning' | 'error' {
  if (days == null) return 'default';
  if (days >= 30) return 'error';
  if (days >= 14) return 'warning';
  return 'default';
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card variant="outlined" sx={{ minWidth: 220, flex: 1 }}>
      <CardContent>
        <Typography variant="body2" color="text.secondary">{label}</Typography>
        <Typography variant="h4" fontWeight={700}>{value}</Typography>
        {sub && <Typography variant="body2" color="text.secondary">{sub}</Typography>}
      </CardContent>
    </Card>
  );
}

export default function OrderToCashPage() {
  const [year, setYear] = useState<number | 'all'>('all');
  const [years, setYears] = useState<number[]>([]);
  const [summary, setSummary] = useState<OrderToCashSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    orderToCashService
      .getSummary(year)
      .then((res) => {
        if (!active) return;
        setSummary(res);
        if (res.years?.length) setYears(res.years);
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Failed to load report'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [year]);

  const orders: UninvoicedOrder[] = summary?.uninvoicedOrders ?? [];

  return (
    <Box data-testid="order-to-cash-page" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5">Order-to-Cash</Typography>
        <Select size="small" value={year} onChange={(e) => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
          <MenuItem value="all">All years</MenuItem>
          {years.map((y) => (
            <MenuItem key={y} value={y}>{y}</MenuItem>
          ))}
        </Select>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}


      {loading && !summary && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {summary && (
        <>
          <Stack direction="row" flexWrap="wrap" gap={2} sx={{ mb: 3 }}>
            <StatCard
              label="Open Orders Value"
              value={currency(summary.openOrders.value)}
              sub={`${summary.openOrders.count.toLocaleString()} order${summary.openOrders.count === 1 ? '' : 's'} not yet invoiced`}
            />
            <StatCard
              label="Average Days to Pay"
              value={summary.avgDaysToPay != null ? `${summary.avgDaysToPay.toFixed(1)} days` : '—'}
              sub={`from ${summary.paidInvoiceCount.toLocaleString()} paid invoice${summary.paidInvoiceCount === 1 ? '' : 's'}, invoice date to first payment`}
            />
          </Stack>

          <Box sx={{ mb: 4 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>Uninvoiced Orders</Typography>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Order #</TableCell>
                    <TableCell>Customer</TableCell>
                    <TableCell>Rep</TableCell>
                    <TableCell>Order Date</TableCell>
                    <TableCell align="right">Days Open</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {orders.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <Typography color="text.secondary" sx={{ py: 2 }}>
                          No open orders — everything's been invoiced.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>{o.refNumber}</TableCell>
                      <TableCell>{o.customerName}</TableCell>
                      <TableCell>{o.salesRepName}</TableCell>
                      <TableCell>{fmtDate(o.txnDate)}</TableCell>
                      <TableCell align="right">
                        <Chip size="small" label={o.daysOpen ?? '—'} color={daysOpenColor(o.daysOpen)} />
                      </TableCell>
                      <TableCell>{o.invoiceStatus}</TableCell>
                      <TableCell align="right">{currency(o.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </>
      )}
    </Box>
  );
}
