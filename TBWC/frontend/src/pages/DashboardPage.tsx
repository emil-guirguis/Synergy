import { Box, Stack, Typography } from '@mui/material';
import { useAuth } from '../hooks/useAuth';
import RepInquiriesCard from '../features/repPortal/RepInquiriesCard';
import RepStatsCards from '../features/repPortal/RepStatsCards';
import OrderAlertsCards from '../features/orders/OrderAlertsCards';
import YearlyOrderTotalCard from '../features/orders/YearlyOrderTotalCard';
import ReceivablesCard from '../features/invoices/ReceivablesCard';

export default function DashboardPage() {
  const { user, isAdmin } = useAuth();
  const firstName = user?.first_name?.trim() || 'there';
  // Receivables is company-wide AR — admin + employee only (both have
  // invoice:read scope 'all'; rep/customer are scoped to 'own' and would leak
  // other customers' balances through the total). type is deprecated in favor
  // of role_id but still the only role signal AuthContext exposes today.
  const isEmployee = user?.type === 'employee';

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Welcome, {firstName}
      </Typography>

      {isAdmin ? (
        <Stack spacing={3}>
          <RepInquiriesCard />
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <YearlyOrderTotalCard />
            <ReceivablesCard />
          </Box>
          <OrderAlertsCards />
        </Stack>
      ) : isEmployee ? (
        <Stack spacing={3}>
          <RepStatsCards />
          <ReceivablesCard />
        </Stack>
      ) : (
        <RepStatsCards />
      )}
    </Box>
  );
}
