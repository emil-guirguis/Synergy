// src/layout/AppLayout.tsx
import React, { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LayoutProps, MenuItem } from '../types';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import './AppLayout.css';

export interface AppLayoutConfig {
  menuItems: MenuItem[];
  sidebarBrand: { icon: string; text: string; logoUrl?: string };
  user?: { name: string; email: string; avatar?: string };
  notifications?: any[];
  notificationComponent?: React.ReactNode;
  onLogout: () => void;
  checkPermission: (permission?: string) => boolean;
  responsive: {
    isMobile: boolean;
    isTablet: boolean;
    isDesktop: boolean;
    showSidebarInHeader: boolean;
  };
  uiState: {
    sidebarCollapsed: boolean;
    setSidebarCollapsed: (collapsed: boolean) => void;
    mobileNavOpen: boolean;
    setMobileNavOpen: (open: boolean) => void;
  };
  usePageTitle?: (title: string) => void;
  getPageTitle?: (pathname: string) => string;
  sidebarContent?: React.ReactNode;
  sidebarDefaultExpanded?: string[];
}

export interface AppLayoutProps extends LayoutProps {
  config: AppLayoutConfig;
}

export const AppLayout: React.FC<AppLayoutProps> = ({
  children,
  title,
  config,
}) => {
  const location = useLocation();
  const navigate = useNavigate();

  const {
    menuItems,
    sidebarBrand,
    user,
    notifications = [],
    notificationComponent,
    onLogout,
    checkPermission,
    responsive,
    uiState,
    getPageTitle,
    sidebarContent,
    sidebarDefaultExpanded,
  } = config;

  const { isMobile, isTablet, isDesktop } = responsive;
  const { sidebarCollapsed, setSidebarCollapsed, mobileNavOpen, setMobileNavOpen } = uiState;

  const brand = sidebarBrand?.text || 'App';
  const pageTitle = title || (getPageTitle ? getPageTitle(location.pathname) : brand);

  // Set document title directly instead of calling usePageTitle hook
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} - ${brand}` : brand;
  }, [pageTitle, brand]);

  useEffect(() => {
    if (isMobile) setSidebarCollapsed(true);
  }, [isMobile, setSidebarCollapsed]);

  const filteredMenuItems = menuItems.filter(
    item => !item.requiredPermission || checkPermission(item.requiredPermission)
  );

  const toggleSidebar = () => {
    if (isMobile || isTablet) {
      setMobileNavOpen(!mobileNavOpen);
    } else {
      setSidebarCollapsed(!sidebarCollapsed);
    }
  };

  const navigateAndClose = (path: string) => {
    navigate(path);
    if (isMobile || isTablet) setMobileNavOpen(false);
  };

  return (
    <div className={`app-layout${sidebarCollapsed && isDesktop ? ' sidebar-collapsed' : ''}`}>
      {/* Header */}
      <Header
        title={pageTitle}
        user={user}
        notifications={notifications}
        notificationComponent={notificationComponent}
        onLogout={onLogout}
        onToggleSidebar={toggleSidebar}
        isMobile={isMobile}
        showSidebarElements={true}
        sidebarBrand={sidebarBrand}
        sidebarCollapsed={sidebarCollapsed}
      />

      {/* Body: Sidebar + Content */}
      <div className="app-layout__body">
        {/* Desktop Sidebar */}
        {!isMobile && !isTablet && (
          <Sidebar
            isCollapsed={sidebarCollapsed}
            isMobile={false}
            menuItems={filteredMenuItems}
            currentPath={location.pathname}
            onToggle={toggleSidebar}
            onNavigate={navigateAndClose}
            sidebarContent={sidebarContent}
            defaultExpanded={sidebarDefaultExpanded}
          />
        )}

        {/* Main Area (Content + Mobile Nav) */}
        <div className="app-layout__main">
          {/* Mobile Navigation Overlay */}
          {(isMobile || isTablet) && (
            <MobileNav
              isOpen={mobileNavOpen}
              onClose={() => setMobileNavOpen(false)}
              menuItems={filteredMenuItems}
              currentPath={location.pathname}
              onNavigate={navigateAndClose}
              sidebarContent={sidebarContent}
            />
          )}

          {/* Page Content */}
          {children}
        </div>
      </div>
    </div>
  );
};