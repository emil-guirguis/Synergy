import { Box, Typography } from '@mui/material';
import { useAuth } from '../hooks/useAuth';
import RepInquiriesCard from '../features/repPortal/RepInquiriesCard';
import RepStatsCards from '../features/repPortal/RepStatsCards';
import OrderAlertsCards from '../features/orders/OrderAlertsCards';
import YearlyOrderTotalCard from '../features/orders/YearlyOrderTotalCard';
import YearlyCommissionTotalCard from '../features/orders/YearlyCommissionTotalCard';

export default function DashboardPage() {
  const { user, isAdmin } = useAuth();
  const firstName = user?.first_name?.trim() || 'there';

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Welcome, {firstName}
      </Typography>

      {isAdmin ? (
        <>
          <RepInquiriesCard />
          <YearlyOrderTotalCard />
          <YearlyCommissionTotalCard />
          <OrderAlertsCards />
        </>
      ) : (
        <RepStatsCards />
      )}
    </Box>
  );
}
