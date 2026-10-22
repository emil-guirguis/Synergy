import { Box, Stack, Typography } from '@mui/material';
import { useAuth } from '../hooks/useAuth';
import RepInquiriesCard from '../features/repPortal/RepInquiriesCard';
import UserDataGapsCard from '../features/repPortal/UserDataGapsCard';
import RepStatsCards from '../features/repPortal/RepStatsCards';
import OrderAlertsCards from '../features/orders/OrderAlertsCards';
import YearlyOrderTotalCard from '../features/orders/YearlyOrderTotalCard';
import RevenueBacklogCard from '../features/orders/RevenueBacklogCard';
import ReceivablesCard from '../features/invoices/ReceivablesCard';

/**
 * The landing page. Every card is shown on its own terms: the grant (and
 * scope) its data actually needs, read off the caller's role — not a role
 * name, and no longer users.is_admin / users.type, which this page used to
 * switch on. A card whose data the viewer can't load is the card that isn't
 * drawn, so a custom role in Settings > Roles composes a dashboard of its own
 * without a code change here.
 *
 * Why scope and not just the permission: a company-wide figure computed from
 * an own-scoped list is a wrong number, not a smaller one — a rep's /orders is
 * filtered to their rows, so "Open sales orders" or company AR built from it
 * would quietly read as the company's. Those cards need 'all'.
 */
export default function DashboardPage() {
  const { user, scopeOf } = useAuth();
  const firstName = user?.first_name?.trim() || 'there';

  const orderScope = scopeOf('order:read');
  // Company-wide order figures (YTD total, backlog, not-shipped/open alerts).
  const companyOrders = orderScope === 'all';
  // Company AR total — same reasoning, on invoices.
  const companyReceivables = scopeOf('invoice:read') === 'all';
  // Portal access requests, the same grant the Rep Approvals page is gated on.
  const canSeeInquiries = scopeOf('repApproval:write') !== null;
  // Data-hygiene counts over public.users (users missing a role / QB rep).
  const canSeeUserGaps = scopeOf('user:read') !== null;
  // "Your" quotes/orders counts. Pointless at 'all' scope (it would count the
  // whole company and call it yours), so this is the own-scoped view's card.
  const ownStats = orderScope === 'own' || scopeOf('quote:read') === 'own';

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Welcome, {firstName}
      </Typography>

      <Stack spacing={3}>
        {canSeeInquiries && <RepInquiriesCard />}
        {canSeeUserGaps && <UserDataGapsCard />}
        {ownStats && <RepStatsCards />}
        {(companyOrders || companyReceivables) && (
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {companyOrders && <YearlyOrderTotalCard />}
            {companyOrders && <RevenueBacklogCard />}
            {companyReceivables && <ReceivablesCard />}
          </Box>
        )}
        {companyOrders && <OrderAlertsCards />}
      </Stack>
    </Box>
  );
}
