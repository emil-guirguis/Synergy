/**
 * Dashboard cards: 2026 orders not yet shipped (shipped_date, QB's own synced
 * ship date), and 2026 "Open Sales Orders" — not invoiced AND nothing shipped
 * yet (actual_ship_date, TBWC's manually-entered field). Admin-only (mirrors
 * RepInquiriesCard's slot on the dashboard) — /orders is unscoped for admins
 * so a plain fetch here covers every order.
 * Fetches via ordersService directly (not the shared useOrders store) — that
 * store is also used by OrderList's paginated/filtered fetch, and this card's
 * own unfiltered bulk fetch would otherwise race it and clobber whichever
 * result lands last.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardActionArea, CardContent, Typography } from '@mui/material';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import { formatNumber } from '@meterit/framework-frontend/utils';
import { ordersService } from './ordersStore';
import type { Order } from '../../types/order';
import CardInfoTooltip from '../../components/common/CardInfoTooltip';

const YEAR = '2026';
const isIn2026 = (o: Order) => !!o.txn_date && o.txn_date.startsWith(YEAR);
const notShipped = (o: Order) => isIn2026(o) && !o.shipped_date;
// Mirrors orders.ts's CHIP_CONDITIONS.openSalesOrder (dashboard-link filter
// only — no Statuses chip or filter-dropdown entry for this one) — not just
// unbilled, but genuinely still pending: nothing has shipped either.
// actual_ship_date is TBWC's own manually-entered field, distinct from
// shipped_date (QB's synced ship date) used by the card above.
const openSalesOrder = (o: Order) => isIn2026(o) && o.invoice_status === 'Not Invoiced' && !o.actual_ship_date;

export default function OrderAlertsCards() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    ordersService.getAll({ limit: 1000 }).then((res) => {
      if (active) setOrders(res.items);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const notShippedCount = orders.filter(notShipped).length;
  const openSalesOrderCount = orders.filter(openSalesOrder).length;

  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 3 }}>
      <Card variant="outlined" sx={{ minWidth: 240, borderColor: notShippedCount > 0 ? 'warning.main' : 'divider' }}>
        <CardActionArea onClick={() => navigate('/orders?notShipped=true')}>
          <CardContent sx={{ position: 'relative', pr: 5 }}>
            <CardInfoTooltip title={`${YEAR} orders where QuickBooks' own Ship Date (shipped_date) hasn't been set yet.`} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <LocalShippingIcon color={notShippedCount > 0 ? 'warning' : 'action'} />
              <Typography variant="body2" color="text.secondary">
                {YEAR} Orders Not Yet Shipped
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {loading ? '…' : formatNumber(notShippedCount)}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>

      <Card variant="outlined" sx={{ minWidth: 240, borderColor: openSalesOrderCount > 0 ? 'warning.main' : 'divider' }}>
        <CardActionArea onClick={() => navigate('/orders?chips=openSalesOrder')}>
          <CardContent sx={{ position: 'relative', pr: 5 }}>
            <CardInfoTooltip title={`${YEAR} orders not yet invoiced AND with no manually-entered Ship Date (actual_ship_date) — not closed, not invoiced, nothing shipped.`} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <RequestQuoteIcon color={openSalesOrderCount > 0 ? 'warning' : 'action'} />
              <Typography variant="body2" color="text.secondary">
                YTD Open Sales Orders
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {loading ? '…' : formatNumber(openSalesOrderCount)}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Box>
  );
}
