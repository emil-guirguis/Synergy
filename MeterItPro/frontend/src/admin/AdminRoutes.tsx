import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { useAuth } from '../hooks/useAuth';

const AdminDashboardPage    = lazy(() => import('./pages/AdminDashboardPage'));
const ClientsPage           = lazy(() => import('./pages/ClientsPage'));
const FinancialsPage        = lazy(() => import('./pages/FinancialsPage'));
const AdminReportsPage      = lazy(() => import('./pages/AdminReportsPage'));
const AdminUsersPage        = lazy(() => import('./pages/AdminUsersPage'));
const CostsPage             = lazy(() => import('./pages/CostsPage'));
const DevicesPage           = lazy(() => import('./pages/DevicesPage'));
const AdminSyncServersPage  = lazy(() => import('./pages/AdminSyncServersPage'));
const SupportTicketsPage    = lazy(() => import('../support/pages/SupportTicketsPage'));

const Spinner = () => (
  <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
    <CircularProgress />
  </Box>
);

/** Any admin flag — gates entry into the admin portal */
const AdminGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user, isLoading } = useAuth();
  if (isLoading) return <Spinner />;
  if (!isAuthenticated || (!user?.is_super_admin && !user?.is_support_admin)) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
};

/** is_super_admin only — full admin pages */
const SuperAdminGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user, isLoading } = useAuth();
  if (isLoading) return <Spinner />;
  if (!isAuthenticated || !user?.is_super_admin) {
    return <Navigate to="/admin/clients" replace />;
  }
  return <>{children}</>;
};

/** is_support_admin — support ticket pages */
const SupportAdminGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user, isLoading } = useAuth();
  if (isLoading) return <Spinner />;
  if (!isAuthenticated || !user?.is_support_admin) {
    return <Navigate to="/admin/clients" replace />;
  }
  return <>{children}</>;
};

const AdminRoutes: React.FC = () => {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        {/* Super admin only */}
        <Route path="/admin/dashboard"  element={<SuperAdminGuard><AdminDashboardPage /></SuperAdminGuard>} />
        <Route path="/admin/financials" element={<SuperAdminGuard><FinancialsPage /></SuperAdminGuard>} />
        <Route path="/admin/reports"    element={<SuperAdminGuard><AdminReportsPage /></SuperAdminGuard>} />
        <Route path="/admin/costs"      element={<SuperAdminGuard><CostsPage /></SuperAdminGuard>} />
        <Route path="/admin/users"        element={<SuperAdminGuard><AdminUsersPage /></SuperAdminGuard>} />
        <Route path="/admin/sync-servers" element={<SuperAdminGuard><AdminSyncServersPage /></SuperAdminGuard>} />

        {/* Both admin types */}
        <Route path="/admin/clients"  element={<AdminGuard><ClientsPage /></AdminGuard>} />
        <Route path="/admin/devices"  element={<AdminGuard><DevicesPage /></AdminGuard>} />

        {/* Support admin */}
        <Route path="/admin/support/tickets"     element={<SupportAdminGuard><SupportTicketsPage /></SupportAdminGuard>} />

        <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
        <Route path="/admin/*" element={<Navigate to="/admin/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
};

export default AdminRoutes;
