/**
 * Dashboard cards: a rep's own active quote count + active order total.
 *
 * Rep-only (admins get RepInquiriesCard instead). Both /quotes and /orders
 * are auto-scoped server-side to rep_id = caller for non-admins, so a plain
 * fetch here already returns only this rep's rows — no extra filtering.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardActionArea, CardContent, Typography } from '@mui/material';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import { useQuotes } from '../quotes/quotesStore';
import { useOrders } from '../orders/ordersStore';

// Quotes still in play — not yet won or lost.
const ACTIVE_QUOTE_STATUSES = new Set(['draft', 'sent']);

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

  // An order is still active while it isn't closed out — not manually closed
  // and not fully invoiced yet.
  const activeOrders = orders.filter((o: any) => !o.is_manually_closed && !o.is_fully_invoiced);
  const activeOrdersTotal = activeOrders.reduce((sum: number, o: any) => sum + (Number(o.total) || 0), 0);

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
                Active Orders
              </Typography>
            </Box>
            <Typography variant="h4" fontWeight={700}>
              {ordersLoading ? '…' : currency(activeOrdersTotal)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {ordersLoading ? '' : `${activeOrders.length} open`}
            </Typography>
          </CardContent>
        </CardActionArea>
      </Card>
    </Box>
  );
}
