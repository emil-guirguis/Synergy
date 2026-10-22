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
 * The landing page. Every card is shown on its own terms, and a card has to
 * pass two tests to be drawn:
 *
 *  1. the grant (and scope) its data actually needs, read off the caller's
 *     role — not a role name, and no longer users.is_admin / users.type, which
 *     this page used to switch on; and
 *  2. the role's own checkbox for that card: Settings > Roles > Dashboard >
 *     Cards (dashboardSchema.ts in the API, stored as `card:<id>` view bits on
 *     dashboard:read, same addressing as any other field rule).
 *
 * Both, deliberately. The checkbox is a view preference — nothing here is a
 * security boundary, since each card fetches a module the caller already holds
 * a grant for — so ticking "Receivables" on for an own-scoped role must not
 * suddenly show them company AR. The grant below is what decides that; the
 * checkbox only takes a card away.
 *
 * Why scope and not just the permission: a company-wide figure computed from
 * an own-scoped list is a wrong number, not a smaller one — a rep's /orders is
 * filtered to their rows, so "Open sales orders" or company AR built from it
 * would quietly read as the company's. Those cards need 'all'.
 */
export default function DashboardPage() {
  const { user, scopeOf, isFieldVisible } = useAuth();
  const firstName = user?.first_name?.trim() || 'there';
  // Unticked in Settings > Roles > Dashboard > Cards. Open by default: a role
  // that has never been edited there shows every card its grants allow.
  const cardOn = (id: string) => isFieldVisible('dashboard:read', `card:${id}`);

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

  const show = {
    repInquiries: canSeeInquiries && cardOn('repInquiries'),
    userDataGaps: canSeeUserGaps && cardOn('userDataGaps'),
    repStats: ownStats && cardOn('repStats'),
    yearlyOrderTotal: companyOrders && cardOn('yearlyOrderTotal'),
    revenueBacklog: companyOrders && cardOn('revenueBacklog'),
    receivables: companyReceivables && cardOn('receivables'),
    orderAlerts: companyOrders && cardOn('orderAlerts'),
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Welcome, {firstName}
      </Typography>

      <Stack spacing={3}>
        {show.repInquiries && <RepInquiriesCard />}
        {show.userDataGaps && <UserDataGapsCard />}
        {show.repStats && <RepStatsCards />}
        {/* One row of figures — skipped entirely when none of the three is on,
            so the empty flex row doesn't add spacing of its own. */}
        {(show.yearlyOrderTotal || show.revenueBacklog || show.receivables) && (
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {show.yearlyOrderTotal && <YearlyOrderTotalCard />}
            {show.revenueBacklog && <RevenueBacklogCard />}
            {show.receivables && <ReceivablesCard />}
          </Box>
        )}
        {show.orderAlerts && <OrderAlertsCards />}
      </Stack>
    </Box>
  );
}
