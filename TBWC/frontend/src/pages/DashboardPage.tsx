import { Box, Stack, Typography } from '@mui/material';
import { useAuth } from '../hooks/useAuth';
import RepInquiriesCard from '../features/repPortal/RepInquiriesCard';
import RepStatsCards from '../features/repPortal/RepStatsCards';
import OrderStatusCard from '../features/orders/OrderStatusCard';
import SupportTicketsCard from '../features/support/SupportTicketsCard';

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
  // Company-wide order figures (not-shipped/open alerts).
  const companyOrders = orderScope === 'all';
  // Portal access requests — every pending request, company-wide, so the same
  // 'all' rule as the figures above (the Rep Approvals page itself is gated on
  // this grant at any scope; what's company-wide is this card's total).
  const canSeeInquiries = scopeOf('repApproval:write') === 'all';
  // "Your" quotes/orders counts. Pointless at 'all' scope (it would count the
  // whole company and call it yours), so this is the own-scoped view's card.
  const ownStats = orderScope === 'own' || scopeOf('quote:read') === 'own';
  // Ticket counts are company-wide (every filer's tickets), so this needs the
  // same 'all' rule as the order figures above, on support's own write grant
  // (support:write is the admin-edit permission — see routes/support.ts).
  const canSeeTickets = scopeOf('support:write') === 'all';

  const show = {
    repInquiries: canSeeInquiries && cardOn('repInquiries'),
    repStats: ownStats && cardOn('repStats'),
    orderStatus: companyOrders && cardOn('orderStatus'),
    supportTickets: canSeeTickets && cardOn('supportTickets'),
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Welcome, {firstName}
      </Typography>

      <Stack spacing={3}>
        {show.repInquiries && <RepInquiriesCard />}
        {show.repStats && <RepStatsCards />}
        {show.orderStatus && <OrderStatusCard />}
        {show.supportTickets && <SupportTicketsCard />}
      </Stack>
    </Box>
  );
}
