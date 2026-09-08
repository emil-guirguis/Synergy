import React, { useState, useRef, useEffect } from 'react';
import type { SidebarProps } from '../types';
import { getIconElement } from '../../utils/iconHelper';
import './Sidebar.css';

/**
 * Sidebar Component
 * 
 * Framework-provided sidebar navigation component with:
 * - Collapsible state
 * - Nested menu items
 * - Active state highlighting
 * - Tooltips in collapsed mode
 * - Responsive behavior
 */
export const Sidebar: React.FC<SidebarProps> = ({
  isCollapsed,
  isMobile,
  menuItems,
  currentPath,
  onToggle,
  onNavigate,
  sidebarContent,
  defaultExpanded,
}) => {
  const [expandedItems, setExpandedItems] = useState<string[]>(defaultExpanded ?? []);
  const asideRef = useRef<HTMLElement | null>(null);

  // Auto-expand parent menus when their children are active
  useEffect(() => {
    const parentsToExpand: string[] = [];
    
    const findActiveParents = (items: any[]) => {
      items.forEach(item => {
        if (item.children && item.children.length > 0) {
          const hasActiveChild = item.children.some((child: any) => child.path === currentPath);
          if (hasActiveChild) {
            parentsToExpand.push(item.id);
          }
        }
      });
    };
    
    findActiveParents(menuItems);
    
    if (parentsToExpand.length > 0) {
      setExpandedItems(prev => {
        const newExpanded = [...prev];
        parentsToExpand.forEach(id => {
          if (!newExpanded.includes(id)) {
            newExpanded.push(id);
          }
        });
        return newExpanded;
      });
    }
  }, [currentPath, menuItems]);

  const handleItemClick = (item: any) => {
    if (item.disabled) return;

    if (item.onClick) {
      item.onClick();
      return;
    }

    const hasChildren = item.children && item.children.length > 0;
    const hasContent = !!item.content;

    if (hasChildren || hasContent) {
      if (isCollapsed && !isMobile) {
        onToggle();
        setExpandedItems(prev =>
          prev.includes(item.id) ? prev : [...prev, item.id]
        );
      } else {
        setExpandedItems(prev =>
          prev.includes(item.id)
            ? prev.filter(id => id !== item.id)
            : [...prev, item.id]
        );
      }
    } else {
      onNavigate(item.path);
    }
  };

  const isItemActive = (item: any): boolean => {
    if (item.isActive !== undefined) return item.isActive;
    if (item.path === currentPath) return true;
    if (item.children) {
      return item.children.some((child: any) => child.path === currentPath);
    }
    return false;
  };

  const renderMenuItem = (item: any, level = 0) => {
    const isActive = isItemActive(item);
    const isExpanded = expandedItems.includes(item.id);
    const hasChildren = item.children && item.children.length > 0;
    const hasContent = !!item.content;
    const isExpandable = hasChildren || hasContent;

    return (
      <li key={item.id} className={`sidebar-item ${level > 0 ? 'sidebar-item--child' : ''}`}>
        <div
          className={`sidebar-link ${isActive ? 'active' : ''} ${isExpandable ? 'has-children' : ''} ${item.disabled ? 'disabled' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleItemClick(item);
          }}
          role="button"
          tabIndex={item.disabled ? -1 : 0}
          aria-disabled={item.disabled || undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              handleItemClick(item);
            }
          }}
        >
          <div className="sidebar-link__content">
            <span className="sidebar-icon">
              {getIconElement(item.icon || item.id)}
            </span>
            {(!isCollapsed || isMobile) && (
              <>
                <span className="sidebar-label">{item.label}</span>
                {item.badge && (
                  <span className="sidebar-badge">{item.badge}</span>
                )}
                {isExpandable && (
                  <span className={`sidebar-arrow ${isExpanded ? 'expanded' : ''}`}>
                    ▼
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Submenu (children) */}
        {hasChildren && (!isCollapsed || isMobile) && (
          <ul className={`sidebar-submenu ${isExpanded ? 'expanded' : ''}`}>
            {item.children.map((child: any) => renderMenuItem(child, level + 1))}
          </ul>
        )}

        {/* Inline custom content */}
        {hasContent && (!isCollapsed || isMobile) && (
          <div className={`sidebar-item__content ${isExpanded ? 'expanded' : ''}`}>
            {item.content}
          </div>
        )}

        {/* Tooltip for collapsed state */}
        {isCollapsed && !isMobile && (
          <div className="sidebar-tooltip">
            {item.label}
            {item.badge && <span className="tooltip-badge">{item.badge}</span>}
          </div>
        )}
      </li>
    );
  };

  return (
    <aside 
      ref={asideRef}
      className={`sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''}`}
      aria-label="Main navigation"
    >
      {/* Custom Sidebar Content (e.g., Meters Section) */}
      {sidebarContent && !isCollapsed && !isMobile && (
        <div className="sidebar__custom-content">
          {sidebarContent}
        </div>
      )}

      <nav className="sidebar__nav" id="main-navigation">
        <ul className="sidebar-menu">
          {menuItems.map(item => renderMenuItem(item))}
        </ul>
      </nav>
    </aside>
  );
};
