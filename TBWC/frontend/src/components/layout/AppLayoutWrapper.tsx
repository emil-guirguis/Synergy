import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { AppLayout } from '@meterit/framework-frontend/layout';
import type { AppLayoutConfig } from '@meterit/framework-frontend/layout';
import { useResponsive } from '@meterit/framework-frontend/hooks/useResponsive';
import { NotificationBell } from '@meterit/framework-frontend/components/notifications';
import { ImpersonationBanner } from '@meterit/framework-frontend/components/auth';
import { isImpersonating, impersonationTargetLabel } from '@meterit/framework-frontend/auth/impersonation';
import { useUI } from '../../store/slices/uiSlice';
import { useAuth } from '../../hooks/useAuth';
import { notificationsService } from '../../services/notificationsService';
import { authService } from '../../services/authService';
import tbwcLogo from '../../assets/tbwc-logo.png';
import { NAV, getPageTitle, filterNav } from './navConfig';

export default function AppLayoutWrapper({ children }: { children: ReactNode }) {
  const { user, checkPermission, logout, updatePreferences } = useAuth();
  const responsive = useResponsive();
  const ui = useUI();

  // The framework's own filter only checks requiredPermission on top-level
  // items, not children (see navConfig.ts) — Utilities' three children each
  // need their own gate, so filter them here before they ever reach it.
  const menuItems = useMemo(() => filterNav(NAV, checkPermission), [checkPermission]);

  const config: AppLayoutConfig = {
    menuItems,
    sidebarBrand: { icon: 'dashboard', text: 'TBWC', logoUrl: tbwcLogo },
    user: { name: user?.name || user?.email || 'User', email: user?.email ?? '' },
    notificationComponent: <NotificationBell api={notificationsService} />,
    onLogout: logout,
    onSavePreferences: updatePreferences,
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

  return (
    <>
      {isImpersonating() && (
        <ImpersonationBanner
          label={impersonationTargetLabel() || 'another user'}
          onExit={() => {
            authService.exitImpersonation();
            window.location.reload();
          }}
        />
      )}
      <AppLayout config={config}>{children}</AppLayout>
    </>
  );
}
