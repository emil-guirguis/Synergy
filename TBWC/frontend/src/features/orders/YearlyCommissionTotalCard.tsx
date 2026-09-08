/**
 * Dashboard card: total commission for a selected year, picked via dropdown.
 * Mirrors YearlyOrderTotalCard but sums commission_total (the Postgres
 * GENERATED commission + overage column) instead of order total.
 * Fetches via ordersService directly (not the shared useOrders store) — that
 * store is also used by OrderList's paginated/filtered fetch, and this card's
 * own unfiltered bulk fetch would otherwise race it and clobber whichever
 * result lands last.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardContent, Typography, Select, MenuItem, CardActionArea } from '@mui/material';
import SavingsIcon from '@mui/icons-material/Savings';
import { ordersService } from './ordersStore';
import type { Order } from '../../types/order';

const DEFAULT_YEAR = '2026';

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

export default function YearlyCommissionTotalCard() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(DEFAULT_YEAR);

  useEffect(() => {
    let active = true;
    ordersService.getAll({ limit: 1000 }).then((res) => {
      if (active) setOrders(res.items);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const years = useMemo(() => {
    const set = new Set<string>([DEFAULT_YEAR]);
    for (const o of orders) {
      if (o.txn_date) set.add(o.txn_date.slice(0, 4));
    }
    return Array.from(set).sort((a, b) => Number(b) - Number(a));
  }, [orders]);

  const yearCommission = useMemo(() => {
    return orders
      .filter((o) => o.txn_date?.startsWith(year))
      .reduce((sum, o) => sum + (Number(o.commission_total) || 0), 0);
  }, [orders, year]);

  return (
    <Card variant="outlined" sx={{ mt: 3, maxWidth: 480 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <SavingsIcon color="action" />
            <Typography variant="body2" color="text.secondary">
              Total Commission
            </Typography>
          </Box>
          <Select
            size="small"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          >
            {years.map((y) => (
              <MenuItem key={y} value={y}>
                {y}
              </MenuItem>
            ))}
          </Select>
        </Box>
        <CardActionArea onClick={() => navigate('/orders')} sx={{ borderRadius: 1 }}>
          <Typography variant="h4" fontWeight={700}>
            {loading ? '…' : currency(yearCommission)}
          </Typography>
        </CardActionArea>
      </CardContent>
    </Card>
  );
}
