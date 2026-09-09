/**
 * Dashboard cards: a rep's own order totals.
 *
 * Rep-only (admins get RepInquiriesCard instead). /orders is auto-scoped
 * server-side to rep_id = caller for non-admins, so a plain fetch here
 * already returns only this rep's rows — no extra filtering.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardActionArea, CardContent, Typography } from '@mui/material';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import PaidIcon from '@mui/icons-material/Paid';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import { useQuotes } from '../quotes/quotesStore';
import { useOrders } from '../orders/ordersStore';

// Quotes still in play — not yet won or lost.
const ACTIVE_QUOTE_STATUSES = new Set(['draft', 'sent']);

const YEAR = '2026';
const isIn2026 = (o: any) => !!o.txn_date && o.txn_date.startsWith(YEAR);

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

export default function RepStatsCards() {
  const navigate = useNavigate();
  const { items: quotes, loading: quotesLoading, fetchItems: fetchQuotes } = useQuotes();
  const { items: orders, loading: ordersLoading, fetchItems: fetchOrders } = useOrders();

  useEffect(() => {
    fetchQuotes({ limit: 500 });
    fetchOrders({ limit: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeQuoteCount = quotes.filter((q: any) => ACTIVE_QUOTE_STATUSES.has(q.status)).length;
  const orderCount = orders.length;
  const orderTotal = orders.filter(isIn2026).reduce((sum: number, o: any) => sum + (Number(o.total) || 0), 0);
  const openOrderCount = orders.filter((o: any) => !o.shipped_date).length;

  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 3 }}>
      <Card variant="outlined" sx={{ minWidth: 220 }}>
        <CardActionArea onClick={() => navigate('/quotes')}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <RequestQuoteIcon color="action" />
              <Typography variant="body2" color="text.secondary">
                Active Quotes
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {quotesLoading ? '…' : activeQuoteCount}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>

      <Card variant="outlined" sx={{ minWidth: 220 }}>
        <CardActionArea onClick={() => navigate('/orders')}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <ShoppingCartIcon color="action" />
              <Typography variant="body2" color="text.secondary">
                Total Orders
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {ordersLoading ? '…' : orderCount}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>

      <Card variant="outlined" sx={{ minWidth: 220 }}>
        <CardActionArea onClick={() => navigate('/orders')}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <PaidIcon color="action" />
              <Typography variant="body2" color="text.secondary">
                YTD Order $
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {ordersLoading ? '…' : currency(orderTotal)}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>

      <Card variant="outlined" sx={{ minWidth: 220 }}>
        <CardActionArea onClick={() => navigate('/orders')}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <LocalShippingIcon color="action" />
              <Typography variant="body2" color="text.secondary">
                Open Orders
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {ordersLoading ? '…' : openOrderCount}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Box>
  );
}
