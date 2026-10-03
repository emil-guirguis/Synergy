/**
 * Sidebar nav — single source of truth for both the sidebar itself
 * (AppLayoutWrapper.tsx) and the Settings > Roles permission tree
 * (pages/SettingsPage.tsx), so a new nav item with a requiredPermission
 * automatically gets a leaf in the roles tree with no second place to edit.
 *
 * requiredPermission's module (the part before ':') is what the roles tree
 * uses to find that item's catalog permissions; the item's own `label` is
 * what the tree displays, so the two always read the same as the sidebar.
 */
import type { MenuItem } from '@meterit/framework-frontend/layout';
import type { RoleTreeNode } from '@meterit/framework-frontend/components/settings';
import { registerIconMappings } from '@meterit/framework-frontend/utils/iconHelper';

registerIconMappings({
  dashboard: 'dashboard',
  users: 'people',
  orders: 'table_chart',
  estimates: 'request_quote',
  inventory: 'inventory_2',
  customers: 'contacts',
  invoices: 'receipt_long',
  payments: 'payments',
  reports: 'assessment',
  repPerformance: 'leaderboard',
  orderToCash: 'sync_alt',
  invoiceTotals: 'trending_up',
  repPortal: 'folder_shared',
  resources: 'folder_shared',
  notifications: 'notifications',
  qbSync: 'sync',
  settings: 'settings',
  quickbooks: 'sync_alt',
  support: 'confirmation_number',
});

export const NAV: MenuItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', path: '/dashboard', requiredPermission: 'dashboard:read' },
  { id: 'estimates', label: 'Estimates', icon: 'estimates', path: '/estimates', disabled: true },
  { id: 'orders', label: 'Orders', icon: 'orders', path: '/orders', requiredPermission: 'order:read' },
  // Reps see Invoices too, scoped to their own by the API (see invoices.ts).
  { id: 'invoices', label: 'Invoices', icon: 'invoices', path: '/invoices', requiredPermission: 'invoice:read' },
  { id: 'aiChat', label: 'Ask AI', icon: 'smart_toy', path: '/ai-chat', requiredPermission: 'aichat:use' },
  {
    id: 'reports',
    label: 'Reports',
    icon: 'reports',
    // No path (not a page, just the dropdown) and no permission of its own —
    // each report below has its own gate (same pattern as Utilities), and
    // filterNav() drops this group entirely if none of them are granted.
    children: [
      { id: 'repPerformance', label: 'Rep Performance', icon: 'repPerformance', path: '/reports/rep-performance', requiredPermission: 'repPerformance:read' },
      { id: 'orderToCash', label: 'Order-to-Cash', icon: 'orderToCash', path: '/reports/order-to-cash', requiredPermission: 'orderToCash:read' },
      { id: 'invoiceTotals', label: 'Invoice Totals', icon: 'invoiceTotals', path: '/reports/invoice-totals', requiredPermission: 'invoiceTotals:read' },
    ],
  },
  {
    id: 'quickbooks',
    label: 'QuickBooks',
    icon: 'quickbooks',
    // filterNav() (below) re-checks requiredPermission per child, so qbSync
    // nested here is independently gated by qbsync:read — it won't leak to a
    // customer/inventory/payment:read holder who lacks it. The one gap: the
    // group itself is gated on inventory:read first, so a role with
    // qbsync:read but NOT inventory:read would lose the item (group dropped
    // before children are even checked). No role is in that shape today
    // (qb-sync is admin-only, and admin holds everything), so safe as-is —
    // revisit if a role ever needs qbsync:read without inventory:read.
    requiredPermission: 'inventory:read',
    children: [
      { id: 'customers', label: 'Customers', icon: 'customers', path: '/customers' },
      { id: 'inventory', label: 'Inventory', icon: 'inventory', path: '/inventory' },
      { id: 'payments', label: 'Payments', icon: 'payments', path: '/payments' },
      { id: 'qbSync', label: 'QB Sync', icon: 'qbSync', path: '/qb-sync', requiredPermission: 'qbsync:read' },
    ],
  },
  {
    id: 'utilities',
    label: 'Utilities',
    icon: 'resources',
    children: [
      { id: 'repPortal', label: 'Rep Approvals', icon: 'repPortal', path: '/rep-portal', requiredPermission: 'repApproval:write' },
      { id: 'resources', label: 'Resources', icon: 'resources', path: '/resources', requiredPermission: 'resource:read' },
      { id: 'notifications', label: 'Notifications', icon: 'notifications', path: '/notifications', requiredPermission: 'notification:read' },
      { id: 'support', label: 'Support', icon: 'support', path: '/support', requiredPermission: 'support:read' },
    ],
  },
  { id: 'users', label: 'Users', icon: 'users', path: '/users', requiredPermission: 'user:read' },
  { id: 'settings', label: 'Settings', icon: 'settings', path: '/settings', requiredPermission: 'setting:read' },
];

export function getPageTitle(pathname: string): string {
  if (pathname.startsWith('/orders')) return 'Orders';
  if (pathname.startsWith('/estimates')) return 'Estimates';
  if (pathname.startsWith('/resources')) return 'Resources';
  if (pathname.startsWith('/notifications')) return 'Notifications';
  if (pathname.startsWith('/ai-chat')) return 'Ask AI';
  if (pathname.startsWith('/support')) return 'Support';
  if (pathname.startsWith('/inventory')) return 'Inventory';
  if (pathname.startsWith('/customers')) return 'Customers';
  if (pathname.startsWith('/invoices')) return 'Invoices';
  if (pathname.startsWith('/payments')) return 'Payments';
  if (pathname.startsWith('/reports/rep-performance')) return 'Rep Performance';
  if (pathname.startsWith('/reports/order-to-cash')) return 'Order-to-Cash';
  if (pathname.startsWith('/reports/invoice-totals')) return 'Invoice Totals';
  if (pathname.startsWith('/rep-portal')) return 'Rep Approvals';
  if (pathname.startsWith('/qb-sync')) return 'QB Sync';
  if (pathname.startsWith('/users')) return 'Users';
  if (pathname.startsWith('/settings')) return 'Settings';
  return 'Dashboard';
}

/**
 * Drops any child the caller lacks the requiredPermission for (the
 * framework's own filter only checks top-level items), and drops a group
 * left with zero visible children and no path of its own.
 */
export function filterNav(nav: MenuItem[], checkPermission: (permission?: string) => boolean): MenuItem[] {
  return nav.reduce<MenuItem[]>((acc, item) => {
    if (item.requiredPermission && !checkPermission(item.requiredPermission)) return acc;
    if (!item.children) {
      acc.push(item);
      return acc;
    }
    const children = filterNav(item.children, checkPermission);
    if (children.length === 0 && !item.path) return acc;
    acc.push({ ...item, children });
    return acc;
  }, []);
}

const moduleOf = (permission: string) => permission.split(':')[0];

/**
 * Walks NAV the same way the sidebar renders it and produces RolesForm's
 * `order`: a top-level module or group per nav item, each carrying the nav's
 * own label so the tree reads exactly like the sidebar. A nav item with no
 * requiredPermission (nothing to gate) and no gated children is skipped —
 * its catalog module, if any, falls through to RolesForm's own "append
 * whatever catalog modules order didn't mention" behavior.
 */
export function roleOrderFromNav(nav: MenuItem[]): RoleTreeNode[] {
  const nodes: RoleTreeNode[] = [];
  for (const item of nav) {
    if (item.children) {
      const childModules = item.children
        .filter((child) => !!child.requiredPermission)
        .map((child) => ({ module: moduleOf(child.requiredPermission!), label: child.label }));
      if (childModules.length) {
        nodes.push({ label: item.label, modules: childModules });
      } else if (item.requiredPermission) {
        // No child carries its own permission (e.g. QuickBooks, whose
        // children share one group-level gate): a single flat leaf, not a
        // group wrapping one child of the same name. SettingsPage.tsx
        // overrides this one — see its comment.
        nodes.push({ module: moduleOf(item.requiredPermission), label: item.label });
      }
      continue;
    }
    if (item.requiredPermission) {
      nodes.push({ module: moduleOf(item.requiredPermission), label: item.label });
    }
  }
  return nodes;
}
