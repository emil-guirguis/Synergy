import type { ReactNode } from 'react';

/**
 * Layout Component Type Definitions
 * 
 * These types are used by the framework layout components
 * and can be extended by client applications.
 */

// Layout Components
export interface LayoutProps {
  children: ReactNode;
  title?: string;
  breadcrumbs?: BreadcrumbItem[];
  actions?: ReactNode;
  loading?: boolean;
}

export interface BreadcrumbItem {
  label: string;
  path?: string;
  icon?: string;
}

export interface HeaderProps {
  title?: string;
  user?: {
    name: string;
    email: string;
    avatar?: string;
  };
  notifications?: Notification[];
  notificationComponent?: ReactNode;
  onLogout: () => void;
  onToggleSidebar: () => void;
  isMobile: boolean;
  showSidebarElements?: boolean;
  sidebarBrand?: {
    icon: string;
    text: string;
    logoUrl?: string;
  };
  sidebarCollapsed?: boolean;
  /** Self-service display preference override (Settings > System Config's
   *  per-user override). Omit to hide the "Preferences" user-menu item. */
  onSavePreferences?: (updates: {
    timezone?: string | null;
    date_format?: string | null;
    time_format?: '12h' | '24h' | null;
    default_page_size?: number | null;
  }) => Promise<void>;
}

export interface SidebarProps {
  isCollapsed: boolean;
  isMobile: boolean;
  menuItems: MenuItem[];
  currentPath: string;
  onToggle: () => void;
  onNavigate: (path: string) => void;
  sidebarContent?: React.ReactNode;
  defaultExpanded?: string[];
}

export interface MenuItem {
  id: string;
  label: string;
  icon: string;
  path: string;
  requiredPermission?: string;
  children?: MenuItem[];
  badge?: string | number;
  /** If provided, called instead of navigating on click */
  onClick?: () => void;
  /** Explicit active override — used for items that have no route */
  isActive?: boolean;
  /** Shown but not clickable/navigable, rendered dimmed */
  disabled?: boolean;
  /** Custom content rendered inline below the item when expanded (replaces children list) */
  content?: ReactNode;
}

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  duration?: number;
  closable?: boolean;
  createdAt: Date;
}
