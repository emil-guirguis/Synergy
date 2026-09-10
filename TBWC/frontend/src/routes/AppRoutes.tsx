import { Navigate, Route, Routes } from 'react-router-dom';
import DashboardPage from '../pages/DashboardPage';
import DocumentsPage from '../pages/DocumentsPage';
import { OrderManagementPage } from '../features/orders/OrderManagementPage';
import { InventoryManagementPage } from '../features/inventory/InventoryManagementPage';
import { QuoteManagementPage } from '../features/quotes/QuoteManagementPage';
import { CustomerManagementPage } from '../features/customers/CustomerManagementPage';
import { InvoiceManagementPage } from '../features/invoices/InvoiceManagementPage';
import { QbSyncDashboardPage } from '../features/qbSync/QbSyncDashboardPage';
import { UserManagementPage } from '../features/users/UserManagementPage';
import RepPortalPage from '../features/repPortal/RepPortalPage';
import SettingsPage from '../pages/SettingsPage';
import { AiChatPage } from '../features/ai/AiChatPage';
import { useAuth } from '../hooks/useAuth';

export default function AppRoutes() {
  const { isAdmin } = useAuth();
  return (
    <Routes>
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/orders" element={<OrderManagementPage />} />
      <Route path="/quotes" element={<QuoteManagementPage />} />
      <Route path="/documents" element={<DocumentsPage />} />
      <Route
        path="/ai-chat"
        element={isAdmin ? <AiChatPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/inventory"
        element={isAdmin ? <InventoryManagementPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/customers"
        element={isAdmin ? <CustomerManagementPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/invoices"
        element={isAdmin ? <InvoiceManagementPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/qb-sync"
        element={isAdmin ? <QbSyncDashboardPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/users"
        element={isAdmin ? <UserManagementPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/rep-portal"
        element={isAdmin ? <RepPortalPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route
        path="/settings"
        element={isAdmin ? <SettingsPage /> : <Navigate to="/dashboard" replace />}
      />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
