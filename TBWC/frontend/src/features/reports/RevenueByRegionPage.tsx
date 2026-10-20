/**
 * Revenue by Region — admin/employee-only. Order revenue grouped into the 4
 * US Census regions, ranked by revenue. The bars are a single-hue ramp off
 * the app's own brand color (theme.palette.primary) rather than a generic
 * chart palette — darkest/most saturated = highest revenue, lightening down
 * the ranking, which also happens to be the correct encoding for a
 * magnitude-ordered set of categories (see revenueByRegion.ts for how
 * "region" itself is derived — there's no region column anywhere in the
 * schema, so it's parsed out of each order's shipping address).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Card, CardContent, CircularProgress, Select, MenuItem, Stack, Typography,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, useTheme,
} from '@mui/material';
import { lighten } from '@mui/material/styles';
import {
  Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { formatCurrency } from '@meterit/framework-frontend/utils';
import { revenueByRegionService } from './revenueByRegionService';
import type { RevenueByRegionRow, RevenueByRegionSummary } from '../../types/revenueByRegion';

const currency = (n: number) => formatCurrency(n, { maximumFractionDigits: 0 });
const currencyCompact = (n: number) => formatCurrency(n, { maximumFractionDigits: 1, notation: 'compact' });

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

const CURRENT_YEAR = new Date().getFullYear();

export default function RevenueByRegionPage() {
  const theme = useTheme();
  const [year, setYear] = useState<number | 'all'>(CURRENT_YEAR);
  const [years, setYears] = useState<number[]>([]);
  const [summary, setSummary] = useState<RevenueByRegionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    revenueByRegionService
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

  const rows = summary?.rows ?? [];

  // Rank among the real (non-Unknown) regions drives the ramp; Unknown always
  // renders neutral grey — it's a data-quality bucket, not a place.
  const rankedRegions = useMemo(() => rows.filter((r) => r.region !== 'Unknown'), [rows]);

  function colorFor(row: RevenueByRegionRow): string {
    if (row.region === 'Unknown') return theme.palette.grey[400];
    const rank = rankedRegions.findIndex((r) => r.region === row.region);
    const steps = Math.max(rankedRegions.length - 1, 1);
    return lighten(theme.palette.primary.main, (rank / steps) * 0.55);
  }

  return (
    <Box data-testid="revenue-by-region-page" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5">Revenue by Region</Typography>
        <Select size="small" value={year} onChange={(e) => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
          <MenuItem value="all">All years</MenuItem>
          {/* years comes from the API's distinct txn_date years — current year is
              added defensively so the picker always has it, even with zero orders
              so far this year (a brand-new year, before the first order lands). */}
          {Array.from(new Set([CURRENT_YEAR, ...years])).sort((a, b) => b - a).map((y) => (
            <MenuItem key={y} value={y}>{y}</MenuItem>
          ))}
        </Select>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && !summary && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      )}

      {summary && rows.length > 0 && (
        <>
          <Stack direction="row" flexWrap="wrap" gap={2} sx={{ mb: 3 }}>
            <StatCard
              label="Total Revenue"
              value={currency(summary.totalRevenue)}
              sub={`${summary.totalOrders.toLocaleString()} orders`}
            />
            <StatCard
              label="Top Region"
              value={rankedRegions[0]?.region ?? '—'}
              sub={rankedRegions[0] ? `${currency(rankedRegions[0].revenue)} · ${rankedRegions[0].pct.toFixed(1)}%` : undefined}
            />
          </Stack>

          <Card variant="outlined" sx={{ mb: 3 }}>
            <CardContent>
              <Box sx={{ width: '100%', height: 56 * rows.length + 40 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={rows}
                    layout="vertical"
                    margin={{ top: 8, right: 56, bottom: 8, left: 8 }}
                    barCategoryGap={18}
                  >
                    <XAxis type="number" hide domain={[0, 'dataMax']} />
                    <YAxis
                      type="category"
                      dataKey="region"
                      width={100}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: theme.palette.text.primary, fontSize: 13, fontWeight: 500 }}
                    />
                    <Tooltip
                      cursor={{ fill: theme.palette.action.hover }}
                      contentStyle={{ borderColor: theme.palette.divider, fontSize: 13, borderRadius: 8 }}
                      labelStyle={{ color: theme.palette.text.primary, fontWeight: 600 }}
                      formatter={(value: any, _name: any, item: any) => [
                        `${currency(Number(value))} · ${item.payload.orders.toLocaleString()} orders · ${item.payload.pct.toFixed(1)}%`,
                        'Revenue',
                      ]}
                    />
                    <Bar dataKey="revenue" radius={[0, 6, 6, 0]} maxBarSize={32} isAnimationActive={false}>
                      {rows.map((row) => (
                        <Cell key={row.region} fill={colorFor(row)} />
                      ))}
                      <LabelList
                        dataKey="revenue"
                        position="right"
                        formatter={(v: any) => currencyCompact(Number(v))}
                        style={{ fill: theme.palette.text.secondary, fontSize: 12, fontWeight: 600 }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Box>
            </CardContent>
          </Card>

          <Box sx={{ mb: 2 }}>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Region</TableCell>
                    <TableCell align="right">Orders</TableCell>
                    <TableCell align="right">Revenue</TableCell>
                    <TableCell align="right">% of Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.region}>
                      <TableCell>{row.region}</TableCell>
                      <TableCell align="right">{row.orders.toLocaleString()}</TableCell>
                      <TableCell align="right">{currency(row.revenue)}</TableCell>
                      <TableCell align="right">{row.pct.toFixed(1)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>

          <Typography variant="body2" color="text.secondary">
            Region is parsed from each order's shipping address (falls back to the billing address when
            ship-to is blank). "Unknown" may consist of will-call / no ship address.
          </Typography>
        </>
      )}

      {summary && rows.length === 0 && (
        <Typography color="text.secondary">No order data for {year === 'all' ? 'any year' : year}.</Typography>
      )}
    </Box>
  );
}
