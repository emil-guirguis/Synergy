import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { useAuth } from '../hooks/useAuth';

const SupportLandingPage  = lazy(() => import('./pages/SupportLandingPage'));
const SupportTicketsPage  = lazy(() => import('./pages/SupportTicketsPage'));
const SupportDevicesPage  = lazy(() => import('./pages/SupportDevicesPage'));
const DocumentationsPage  = lazy(() => import('./pages/DocumentationsPage'));

const Spinner = () => (
  <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
    <CircularProgress />
  </Box>
);

/** Any authenticated user */
const SupportAuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <Spinner />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

/** is_support_admin only */
const AdminSupportGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user, isLoading } = useAuth();
  if (isLoading) return <Spinner />;
  if (!isAuthenticated || !user?.is_support_admin) {
    return <Navigate to="/support/tickets" replace />;
  }
  return <>{children}</>;
};

const SupportRoutes: React.FC = () => (
  <Suspense fallback={<Spinner />}>
    <Routes>
      <Route path="/support"            element={<SupportLandingPage />} />
      <Route path="/support/documentations" element={<DocumentationsPage />} />
      <Route path="/support/tickets"    element={<SupportAuthGuard><SupportTicketsPage /></SupportAuthGuard>} />
      <Route path="/support/devices"    element={<AdminSupportGuard><SupportDevicesPage /></AdminSupportGuard>} />
      <Route path="/support/*"          element={<Navigate to="/support" replace />} />
    </Routes>
  </Suspense>
);

export default SupportRoutes;
