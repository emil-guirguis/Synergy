/**
 * Sales Rep Performance & Commission Tracker — admin/employee-only.
 * Three views over one GET /reports/rep-performance/summary fetch (per-rep,
 * per-year): booked vs. collected, the commission payout ledger (paid
 * invoices only — see repPerformance.ts for why), and a leaderboard ranked by
 * revenue with gross margin and average collection time.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Box, CircularProgress, Select, MenuItem, Stack, Typography,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper,
} from '@mui/material';
import { repPerformanceService } from './repPerformanceService';
import type { RepPerformanceRow, RepPerformanceSummary } from '../../types/repPerformance';

const CURRENT_YEAR = new Date().getFullYear();

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

const percent = (n: number) => `${n.toFixed(1)}%`;

function pctCollected(row: RepPerformanceRow): string {
  return row.booked > 0 ? percent((row.collected / row.booked) * 100) : '—';
}

function marginPct(row: RepPerformanceRow): string {
  return row.revenue > 0 ? percent((row.grossProfit / row.revenue) * 100) : '—';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>{title}</Typography>
      <TableContainer component={Paper} variant="outlined">
        {children}
      </TableContainer>
    </Box>
  );
}

export default function RepPerformancePage() {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [years, setYears] = useState<number[]>([CURRENT_YEAR]);
  const [summary, setSummary] = useState<RepPerformanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    repPerformanceService
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

  const items = summary?.items ?? [];
  const leaderboard = [...items].sort((a, b) => b.revenue - a.revenue);

  return (
    <Box data-testid="rep-performance-page" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5">Sales Rep Performance & Commission Tracker</Typography>
        <Select size="small" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => (
            <MenuItem key={y} value={y}>{y}</MenuItem>
          ))}
        </Select>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}


      {loading && !summary && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {summary && items.length === 0 && (
        <Typography color="text.secondary">No active sales reps with activity in {year}.</Typography>
      )}

      {summary && items.length > 0 && (
        <>
          <Section title="Total Booked Sales vs. Total Collected Revenue">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Rep</TableCell>
                  <TableCell align="right">Invoices Issued</TableCell>
                  <TableCell align="right">Booked (Invoiced)</TableCell>
                  <TableCell align="right">Collected</TableCell>
                  <TableCell align="right">% Collected</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={row.list_id}>
                    <TableCell>{row.name}</TableCell>
                    <TableCell align="right">{row.invoiceCount}</TableCell>
                    <TableCell align="right">{currency(row.booked)}</TableCell>
                    <TableCell align="right">{currency(row.collected)}</TableCell>
                    <TableCell align="right">{pctCollected(row)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section title="Commission Payout Ledger">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Rep</TableCell>
                  <TableCell align="right">Paid Orders</TableCell>
                  <TableCell align="right">Commission Payout</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={row.list_id}>
                    <TableCell>{row.name}</TableCell>
                    <TableCell align="right">{row.paidOrderCount}</TableCell>
                    <TableCell align="right">{currency(row.commissionPaid)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section title="Rep Leaderboard">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>Rep</TableCell>
                  <TableCell align="right">Revenue (Sold For)</TableCell>
                  <TableCell align="right">Gross Margin</TableCell>
                  <TableCell align="right">Avg. Collection Time</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {leaderboard.map((row, i) => (
                  <TableRow key={row.list_id}>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell align="right">{currency(row.revenue)}</TableCell>
                    <TableCell align="right">{marginPct(row)}</TableCell>
                    <TableCell align="right">
                      {row.avgCollectionDays != null ? `${row.avgCollectionDays.toFixed(1)} days` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}
    </Box>
  );
}
