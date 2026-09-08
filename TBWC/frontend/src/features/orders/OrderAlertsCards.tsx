/**
 * Dashboard cards: 2026 orders missing a PO number, 2026 orders not yet
 * shipped, and all orders not yet (fully) invoiced. Admin-only (mirrors
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
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import { ordersService } from './ordersStore';
import type { Order } from '../../types/order';

const YEAR = '2026';
const isIn2026 = (o: Order) => !!o.txn_date && o.txn_date.startsWith(YEAR);
const missingPo = (o: Order) => isIn2026(o) && !o.po_number?.trim();
const notShipped = (o: Order) => isIn2026(o) && !o.shipped_date;
// Not year-scoped, unlike the two alerts above — an unbilled order stays
// outstanding regardless of when it was placed.
const notInvoiced = (o: Order) => !o.is_fully_invoiced;

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

  const missingPoCount = orders.filter(missingPo).length;
  const notShippedCount = orders.filter(notShipped).length;
  const notInvoicedCount = orders.filter(notInvoiced).length;

  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 3 }}>
      <Card variant="outlined" sx={{ minWidth: 220, borderColor: missingPoCount > 0 ? 'warning.main' : 'divider' }}>
        <CardActionArea onClick={() => navigate('/orders?missingPo=true')}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <ReceiptLongIcon color={missingPoCount > 0 ? 'warning' : 'action'} />
              <Typography variant="body2" color="text.secondary">
                {YEAR} Orders Missing PO #
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {loading ? '…' : missingPoCount}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>

      <Card variant="outlined" sx={{ minWidth: 220, borderColor: notShippedCount > 0 ? 'warning.main' : 'divider' }}>
        <CardActionArea onClick={() => navigate('/orders?notShipped=true')}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <LocalShippingIcon color={notShippedCount > 0 ? 'warning' : 'action'} />
              <Typography variant="body2" color="text.secondary">
                {YEAR} Orders Not Yet Shipped
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {loading ? '…' : notShippedCount}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>

      <Card variant="outlined" sx={{ minWidth: 220, borderColor: notInvoicedCount > 0 ? 'warning.main' : 'divider' }}>
        <CardActionArea onClick={() => navigate('/orders?is_fully_invoiced=false')}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <RequestQuoteIcon color={notInvoicedCount > 0 ? 'warning' : 'action'} />
              <Typography variant="body2" color="text.secondary">
                Orders Not Invoiced
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {loading ? '…' : notInvoicedCount}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Box>
  );
}
