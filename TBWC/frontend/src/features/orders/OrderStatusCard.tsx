/**
 * Dashboard card: order counts for 3 of the Statuses chips OrderList.tsx
 * renders per row (Not Invoiced / Missing Financials / Not Shipped) — the
 * three that flag something needing attention, not every chip in the set
 * (Closed/Hold for Release/Consignment are normal, uninteresting states) —
 * plus YTD Open Sales Orders, an informational count rather than an alert
 * (it's normally nonzero), so it doesn't factor into the warning border/icon
 * below and renders in its own neutral color regardless of count. Formerly
 * its own card (OrderAlertsCards.tsx, removed) — folded in here as a pill.
 * Counts come from /orders?chips=<key>&limit=1 (findAll's pagination.total),
 * not a client-side tally — same CHIP_CONDITIONS predicate OrderList's own
 * chip filter uses (orders.ts), so this card can't drift out of sync with
 * what clicking a pill actually filters to.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardActionArea, CardContent, Chip, Typography } from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import { formatNumber } from '@meterit/framework-frontend/utils';
import { ordersService } from './ordersStore';
import CardInfoTooltip from '../../components/common/CardInfoTooltip';

const ALERT_CHIPS: { key: string; label: string }[] = [
  { key: 'notInvoiced', label: 'Not Invoiced' },
  { key: 'missingFinancials', label: 'Missing Financials' },
  { key: 'notShipped', label: 'Not Shipped' },
];
const INFO_CHIP = { key: 'openSalesOrder', label: 'YTD Open Sales Orders' };
const ALL_CHIPS = [...ALERT_CHIPS, INFO_CHIP];

export default function OrderStatusCard() {
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all(ALL_CHIPS.map((c) => ordersService.getAll({ limit: 1, filters: { chips: c.key } })))
      .then((results) => {
        if (!active) return;
        setCounts(Object.fromEntries(ALL_CHIPS.map((c, i) => [c.key, results[i].total])));
      })
      .catch(() => {
        /* leave counts unset on error */
      });
    return () => { active = false; };
  }, []);

  const alertTotal = counts ? ALERT_CHIPS.reduce((sum, c) => sum + (counts[c.key] ?? 0), 0) : 0;

  return (
    <Card variant="outlined" sx={{ mt: 3, minWidth: 240, maxWidth: 480, borderColor: alertTotal > 0 ? 'warning.main' : 'divider' }}>
      <CardActionArea onClick={() => navigate('/orders')}>
        <CardContent sx={{ position: 'relative', pr: 5 }}>
          <CardInfoTooltip title="Not Invoiced = shipped but not yet invoiced. Missing Financials = sold for / commission / net cost not filled in (2026+ orders only). Not Shipped = ship-by date passed with no ship date set. YTD Open Sales Orders = not yet invoiced and nothing shipped." />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <FactCheckIcon color={alertTotal > 0 ? 'warning' : 'action'} />
            <Typography variant="h6" fontWeight={700}>
              Order Statuses
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {!counts ? (
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            ) : (
              ALL_CHIPS.map(({ key, label }) => (
                <Chip
                  key={key}
                  label={`${label}: ${formatNumber(counts[key] ?? 0)}`}
                  size="small"
                  variant="outlined"
                  clickable
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/orders?chips=${key}`);
                  }}
                  color={key !== INFO_CHIP.key && (counts[key] ?? 0) > 0 ? 'warning' : 'default'}
                />
              ))
            )}
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
