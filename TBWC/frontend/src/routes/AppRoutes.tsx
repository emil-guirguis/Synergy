import { Navigate, Route, Routes } from 'react-router-dom';
import DashboardPage from '../pages/DashboardPage';
import ResourcesPage from '../pages/ResourcesPage';
import NotificationsPage from '../pages/NotificationsPage';
import { OrderManagementPage } from '../features/orders/OrderManagementPage';
import { InventoryManagementPage } from '../features/inventory/InventoryManagementPage';
import { EstimateManagementPage } from '../features/estimates/EstimateManagementPage';
import { CustomerManagementPage } from '../features/customers/CustomerManagementPage';
import { InvoiceManagementPage } from '../features/invoices/InvoiceManagementPage';
import { PaymentManagementPage } from '../features/payments/PaymentManagementPage';
import RepPerformancePage from '../features/reports/RepPerformancePage';
import OrderToCashPage from '../features/reports/OrderToCashPage';
import InvoiceTotalsPage from '../features/reports/InvoiceTotalsPage';
import { QbSyncDashboardPage } from '../features/qbSync/QbSyncDashboardPage';
import { UserManagementPage } from '../features/users/UserManagementPage';
import RepPortalPage from '../features/repPortal/RepPortalPage';
import SettingsPage from '../pages/SettingsPage';
import { AiChatPage } from '../features/ai/AiChatPage';
import { useAuth } from '../hooks/useAuth';

export default function AppRoutes() {
  const { checkPermission } = useAuth();
  return (
    <Routes>
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/orders" element={<OrderManagementPage />} />
      {/* Read-only for reps; the API scopes them to their own (see estimates.ts). */}
      <Route path="/estimates" element={<EstimateManagementPage />} />
      <Route
        path="/resources"
        element={checkPermission('resource:read') ? <ResourcesPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route path="/notifications" element={<NotificationsPage />} />
      <Route
        path="/ai-chat"
        element={checkPermission('aichat:use') ? <AiChatPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/inventory"
        element={checkPermission('inventory:read') ? <InventoryManagementPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/customers"
        element={checkPermission('customer:read') ? <CustomerManagementPage /> : <Navigate to="/dashboard" replace />}
      />
      {/* Read-only for everyone; the API scopes a rep to their own invoices. */}
      <Route path="/invoices" element={<InvoiceManagementPage />} />
      <Route
        path="/payments"
        element={checkPermission('payment:read') ? <PaymentManagementPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/reports/rep-performance"
        element={checkPermission('repPerformance:read') ? <RepPerformancePage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/reports/order-to-cash"
        element={checkPermission('orderToCash:read') ? <OrderToCashPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/reports/invoice-totals"
        element={checkPermission('invoiceTotals:read') ? <InvoiceTotalsPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/qb-sync"
        element={checkPermission('qbsync:read') ? <QbSyncDashboardPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/users"
        element={checkPermission('user:read') ? <UserManagementPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/rep-portal"
        element={checkPermission('repApproval:write') ? <RepPortalPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/settings"
        element={checkPermission('setting:read') ? <SettingsPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
