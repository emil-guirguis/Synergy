import { useCallback, type ReactNode } from 'react';
import { AppLayout } from '@meterit/framework-frontend/layout';
import type { MenuItem, AppLayoutConfig } from '@meterit/framework-frontend/layout';
import { useResponsive } from '@meterit/framework-frontend/hooks/useResponsive';
import { registerIconMappings } from '@meterit/framework-frontend/utils/iconHelper';
import { useUI } from '../../store/slices/uiSlice';
import { useAuth } from '../../hooks/useAuth';
import tbwcLogo from '../../assets/tbwc-logo.png';

registerIconMappings({
  dashboard: 'dashboard',
  users: 'people',
  orders: 'table_chart',
  quotes: 'request_quote',
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
  qbSync: 'sync',
  settings: 'settings',
});

const NAV: MenuItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', path: '/dashboard' },
  { id: 'quotes', label: 'Quotes', icon: 'quotes', path: '/quotes', disabled: true },
  { id: 'orders', label: 'Orders', icon: 'orders', path: '/orders' },
  { id: 'aiChat', label: 'Ask AI', icon: 'smart_toy', path: '/ai-chat', requiredPermission: 'admin' },
  // Reps see Invoices too, scoped to their own by the API (see invoices.ts).
  { id: 'invoices', label: 'Invoices', icon: 'invoices', path: '/invoices' },
  { id: 'payments', label: 'Payments', icon: 'payments', path: '/payments', requiredPermission: 'admin' },
  {
    id: 'reports',
    label: 'Reports',
    icon: 'reports',
    path: '/reports',
    requiredPermission: 'admin',
    children: [
      { id: 'repPerformance', label: 'Rep Performance', icon: 'repPerformance', path: '/reports/rep-performance' },
      { id: 'orderToCash', label: 'Order-to-Cash', icon: 'orderToCash', path: '/reports/order-to-cash' },
      { id: 'invoiceTotals', label: 'Invoice Totals', icon: 'invoiceTotals', path: '/reports/invoice-totals' },
    ],
  },
  { id: 'customers', label: 'Customers', icon: 'customers', path: '/customers', requiredPermission: 'admin' },
  { id: 'inventory', label: 'Inventory', icon: 'inventory', path: '/inventory', requiredPermission: 'admin' },
  { id: 'repPortal', label: 'Rep Approvals', icon: 'repPortal', path: '/rep-portal', requiredPermission: 'admin' },
  { id: 'resources', label: 'Resources', icon: 'resources', path: '/resources' },
  { id: 'qbSync', label: 'QB Sync', icon: 'qbSync', path: '/qb-sync', requiredPermission: 'admin' },
  { id: 'users', label: 'Users', icon: 'users', path: '/users', requiredPermission: 'admin' },
  { id: 'settings', label: 'Settings', icon: 'settings', path: '/settings', requiredPermission: 'admin' },
];

function getPageTitle(pathname: string): string {
  if (pathname.startsWith('/quotes')) return 'Quotes';
  if (pathname.startsWith('/orders')) return 'Orders';
  if (pathname.startsWith('/resources')) return 'Resources';
  if (pathname.startsWith('/ai-chat')) return 'Ask AI';
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

export default function AppLayoutWrapper({ children }: { children: ReactNode }) {
  const { user, isAdmin, logout } = useAuth();
  const responsive = useResponsive();
  const ui = useUI();

  const checkPermission = useCallback(
    (permission?: string) => {
      if (permission === 'admin') return isAdmin;
      if (permission === 'nonAdmin') return !isAdmin;
      return true;
    },
    [isAdmin]
  );

  const config: AppLayoutConfig = {
    menuItems: NAV,
    sidebarBrand: { icon: 'dashboard', text: 'TBWC', logoUrl: tbwcLogo },
    user: { name: user?.name || user?.email || 'User', email: user?.email ?? '' },
    onLogout: logout,
    checkPermission,
    responsive: {
      isMobile: responsive.isMobile,
      isTablet: responsive.isTablet,
      isDesktop: responsive.isDesktop,
      showSidebarInHeader: responsive.showSidebarInHeader,
    },
    uiState: {
      sidebarCollapsed: ui.sidebarCollapsed,
      setSidebarCollapsed: ui.setSidebarCollapsed,
      mobileNavOpen: ui.mobileNavOpen,
      setMobileNavOpen: ui.setMobileNavOpen,
    },
    getPageTitle,
  };

  return <AppLayout config={config}>{children}</AppLayout>;
}
