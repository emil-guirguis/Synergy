/**
 * Dashboard card: outstanding support tickets (status open or in_progress —
 * i.e. not resolved/closed yet), with a breakdown by type. Backed by the
 * existing admin-only GET /support/analytics (by_status/by_type), same data
 * SupportAnalyticsSummary uses inside the Support module itself — this is
 * just the landing-page-sized slice of it. Clicking the card opens Support.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardActionArea, CardContent, Chip, Typography } from '@mui/material';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import { formatNumber } from '@meterit/framework-frontend/utils';
import type { SupportAnalytics } from '@meterit/framework-frontend/support';
import { supportTicketService } from './supportTicketsStore';
import CardInfoTooltip from '../../components/common/CardInfoTooltip';

// supportTicketSchema's own enumLabels only overrides 'rma' — everything else
// falls back to this same title-case-the-snake-case rule the schema-driven
// grids use (schemaColumnGenerator.ts's humanizeEnumValue, not exported).
const TYPE_LABELS: Record<string, string> = { rma: 'RMA' };
const typeLabel = (type: string): string =>
  TYPE_LABELS[type] ?? type.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

export default function SupportTicketsCard() {
  const navigate = useNavigate();
  const [data, setData] = useState<SupportAnalytics | null>(null);

  useEffect(() => {
    let active = true;
    supportTicketService.getAnalytics().then((res) => {
      if (active) setData(res);
    }).catch(() => {
      /* leave counts at zero on error */
    });
    return () => { active = false; };
  }, []);

  const outstanding = (data?.by_status?.open ?? 0) + (data?.by_status?.in_progress ?? 0);
  const byType = Object.entries(data?.by_type ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <Card variant="outlined" sx={{ mt: 3, minWidth: 240, maxWidth: 480, borderColor: outstanding > 0 ? 'warning.main' : 'divider' }}>
      <CardActionArea onClick={() => navigate('/support')}>
        <CardContent sx={{ position: 'relative', pr: 5 }}>
          <CardInfoTooltip title="Outstanding = status open or in_progress. Breakdown is by ticket type, across all tickets regardless of status." />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <SupportAgentIcon color={outstanding > 0 ? 'warning' : 'action'} />
            <Typography variant="h6" fontWeight={700}>
              {data ? formatNumber(outstanding) : '…'} outstanding {outstanding === 1 ? 'ticket' : 'tickets'}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {!data ? (
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            ) : byType.length === 0 ? (
              <Typography variant="body2" color="text.secondary">No tickets yet</Typography>
            ) : (
              byType.map(([type, count]) => (
                <Chip
                  key={type}
                  label={`${typeLabel(type)}: ${formatNumber(count)}`}
                  size="small"
                  variant="outlined"
                  clickable
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/support?type=${type}`);
                  }}
                />
              ))
            )}
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
