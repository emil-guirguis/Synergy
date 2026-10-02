import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AppRoutes from './routes/AppRoutes';
import AppLayoutWrapper from './components/layout/AppLayoutWrapper';
import AdminApp from './admin/AdminApp';
import SupportApp from './support/SupportApp';
import AdminBanner from './components/AdminBanner';
import { ImpersonationBanner } from '@meterit/framework-frontend/components/auth';
import { isImpersonating as isUserImpersonating, impersonationTargetLabel } from '@meterit/framework-frontend/auth/impersonation';
import authService from './services/authService';
import { prefetchAppSchemas, prefetchAppRoutes } from './utils/schemaPrefetch';
import { invalidateExpiredCache } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import { useAuth } from './hooks/useAuth';
import { setupDebugConsole } from './utils/debugConsole';
import { MeterSelectionProvider } from './contexts/MeterSelectionContext';
import { NotificationProvider } from './components/NotificationProvider';
import '@meterit/framework-frontend/components/common/TableCellStyles.css';
import './App.css';

setupDebugConsole();

const appStartTime = performance.now();

function App() {
  const { isAuthenticated, user, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const isAdminSection = location.pathname.startsWith('/admin');
  const isSupportSection = location.pathname.startsWith('/support');
  const isImpersonating = user?.isAdminView === true;

  useEffect(() => {
    console.log(`[App +${(performance.now() - appStartTime).toFixed(0)}ms] isAuthenticated=${isAuthenticated} isLoading=${isLoading}`);
  }, [isAuthenticated, isLoading]);

  // Prefetch schemas for the client portal (not needed in admin or support section)
  useEffect(() => {
    if (isAuthenticated && !isLoading && !isAdminSection && !isSupportSection) {
      console.log(`[App +${(performance.now() - appStartTime).toFixed(0)}ms] Auth resolved — layout mounting, starting prefetch`);
      prefetchAppRoutes();
      prefetchAppSchemas().catch((error) => {
        console.error('[App] Schema prefetch failed:', error);
      });
    }
  }, [isAuthenticated, isLoading, isAdminSection]);

  // Periodically clean up expired schema cache entries
  useEffect(() => {
    const interval = setInterval(() => {
      const removed = invalidateExpiredCache();
      if (removed > 0) {
        console.log(`[Schema Cache] Cleaned up ${removed} expired cache entries`);
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Redirect admin users from client portal to admin portal
  useEffect(() => {
    if (!isLoading && isAuthenticated && !isImpersonating) {
      if (user?.is_super_admin && !isAdminSection && !isSupportSection) {
        navigate('/admin/dashboard', { replace: true });
      } else if (user?.is_support_admin && !user?.is_super_admin && !isSupportSection && !isAdminSection) {
        navigate('/support/tickets', { replace: true });
      }
    }
  }, [isLoading, isAuthenticated, user?.is_super_admin, user?.is_support_admin, isAdminSection, isSupportSection, isImpersonating, navigate]);

  return (
    <NotificationProvider>
      <MeterSelectionProvider>
        {isAdminSection ? (
          <AdminApp />
        ) : isSupportSection ? (
          <SupportApp />
        ) : (
          <>
            {isImpersonating && <AdminBanner />}
            {isUserImpersonating() && (
              <ImpersonationBanner
                label={impersonationTargetLabel() || 'another user'}
                onExit={() => {
                  authService.exitImpersonation();
                  window.location.reload();
                }}
              />
            )}
            {isAuthenticated && !isLoading ? (
              <AppLayoutWrapper>
                <AppRoutes />
              </AppLayoutWrapper>
            ) : (
              <AppRoutes />
            )}
          </>
        )}
      </MeterSelectionProvider>
    </NotificationProvider>
  );
}

export default App;
