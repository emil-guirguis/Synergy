/**
 * Dashboard card: total outstanding AR (balance_remaining > 0) on invoices for
 * a selected year, picked via dropdown — same UX as YearlyOrderTotalCard's
 * year select. Admin + employee only — company-wide money a rep shouldn't see
 * (gated by the caller, see DashboardPage.tsx).
 *
 * Both the total and the dropdown's own year options come from
 * GET /invoices/receivables-summary (server-side SUM + DISTINCT), not the
 * bulk-fetch-and-reduce pattern the other dashboard cards use — see that
 * route's comment for why.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardActionArea, CardContent, Box, Typography, Select, MenuItem } from '@mui/material';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import { invoiceService } from './invoiceStore';

const CURRENT_YEAR = new Date().getFullYear();

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

export default function ReceivablesCard() {
  const navigate = useNavigate();
  const [year, setYear] = useState(CURRENT_YEAR);
  const [years, setYears] = useState<number[]>([CURRENT_YEAR]);
  const [total, setTotal] = useState(0);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    invoiceService
      .getReceivablesSummary(year)
      .then((res) => {
        if (!active) return;
        setTotal(res.total);
        setCount(res.count);
        if (res.years?.length) setYears(res.years);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [year]);

  return (
    <Card variant="outlined" sx={{ minWidth: 220, maxWidth: 480 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <RequestQuoteIcon color="action" />
            <Typography variant="body2" color="text.secondary">
              Total Receivables
            </Typography>
          </Box>
          <Select
            size="small"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            onClick={(e) => e.stopPropagation()}
          >
            {years.map((y) => (
              <MenuItem key={y} value={y}>
                {y}
              </MenuItem>
            ))}
          </Select>
        </Box>
        <CardActionArea onClick={() => navigate('/invoices?is_paid=false')} sx={{ borderRadius: 1 }}>
          <Typography variant="h4" fontWeight={700}>
            {loading ? '…' : currency(total)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {loading ? '…' : `${count.toLocaleString()} unpaid ${count === 1 ? 'invoice' : 'invoices'}`}
          </Typography>
        </CardActionArea>
      </CardContent>
    </Card>
  );
}
