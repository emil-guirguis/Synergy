/**
 * Support Tickets "Basic Analytics" tiles — ticket volume, avg resolution
 * time, CSAT. Admin-only (ticketService.getAnalytics is omitted for
 * non-admin callers, see types.ts), deliberately simple stat tiles rather
 * than a trend chart.
 */
import React, { useEffect, useState } from 'react';
import { Box, Card, CardContent, CircularProgress, Grid, Rating, Typography } from '@mui/material';
import type { SupportAnalytics, SupportTicketService } from './types';

export interface SupportAnalyticsSummaryProps {
  ticketService: SupportTicketService;
}

function formatHours(hours: number | null): string {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Grid item xs={6} sm={4} md={2}>
      <Card variant="outlined" sx={{ height: '100%' }}>
        <CardContent>
          <Typography variant="caption" color="text.secondary">{label}</Typography>
          <Typography variant="h5" fontWeight="bold">{value}</Typography>
          {sub != null && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
        </CardContent>
      </Card>
    </Grid>
  );
}

export const SupportAnalyticsSummary: React.FC<SupportAnalyticsSummaryProps> = ({ ticketService }) => {
  const [data, setData] = useState<SupportAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticketService.getAnalytics) { setLoading(false); return; }
    let cancelled = false;
    ticketService.getAnalytics()
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { /* analytics tiles are a nice-to-have — fail quietly, the list below still works */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticketService]);

  if (!ticketService.getAnalytics) return null;
  if (loading) {
    return (
      <Box display="flex" justifyContent="center" py={2}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (!data) return null;

  const open = data.by_status.open ?? 0;
  const inProgress = data.by_status.in_progress ?? 0;

  return (
    <Grid container spacing={2} sx={{ mb: 3 }}>
      <Tile label="Total tickets" value={data.total} sub={`${data.last_7_days} in last 7 days`} />
      <Tile label="Open" value={open} />
      <Tile label="In Progress" value={inProgress} />
      <Tile label="Avg Resolution Time" value={formatHours(data.avg_resolution_hours)} />
      <Tile
        label="CSAT"
        value={data.avg_csat != null ? data.avg_csat.toFixed(1) : '—'}
        sub={
          data.csat_count > 0 ? (
            <Box display="flex" alignItems="center" gap={0.5}>
              <Rating value={data.avg_csat} precision={0.5} size="small" readOnly />
              <span>({data.csat_count})</span>
            </Box>
          ) : 'No ratings yet'
        }
      />
      <Tile label="Resolved / Closed" value={`${data.by_status.resolved ?? 0} / ${data.by_status.closed ?? 0}`} />
    </Grid>
  );
};

export default SupportAnalyticsSummary;
