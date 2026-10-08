/**
 * Dashboard card: Revenue Backlog & Pipeline — the value of open (Not
 * Invoiced / Partially Invoiced) orders still owed to the business, net of
 * what's already been invoiced against them. A snapshot of right now, not a
 * per-year figure (unlike YearlyOrderTotalCard/ReceivablesCard), so there's
 * no year dropdown here.
 *
 * Figure comes from GET /orders/reports/backlog (server-side SUM) — see that
 * route's comment in routes/orders.ts for exactly what counts.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardActionArea, CardContent, Box, Typography } from '@mui/material';
import TimelineIcon from '@mui/icons-material/Timeline';
import { formatCurrency } from '@meterit/framework-frontend/utils';
import { ordersService } from './ordersStore';
import CardInfoTooltip from '../../components/common/CardInfoTooltip';

const currency = (n: number) => formatCurrency(n, { maximumFractionDigits: 0 });

export default function RevenueBacklogCard() {
  const navigate = useNavigate();
  const [total, setTotal] = useState(0);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    ordersService.getBacklogReport()
      .then((res) => {
        if (!active) return;
        setTotal(res.backlogTotal);
        setCount(res.orderCount);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <Card variant="outlined" sx={{ minWidth: 240, maxWidth: 480 }}>
      <CardContent sx={{ position: 'relative', pr: 5 }}>
        <CardInfoTooltip title="Open (Not Invoiced / Partially Invoiced) order value minus what's already been invoiced against those orders — what's still owed to the business." />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <TimelineIcon color="action" />
          <Typography variant="body2" color="text.secondary">
            Revenue Backlog
          </Typography>
        </Box>
        <CardActionArea onClick={() => navigate('/orders')} sx={{ borderRadius: 1 }}>
          <Typography variant="h4" fontWeight={700}>
            {loading ? '…' : currency(total)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {loading ? '…' : `${count.toLocaleString()} open ${count === 1 ? 'order' : 'orders'}`}
          </Typography>
        </CardActionArea>
      </CardContent>
    </Card>
  );
}
