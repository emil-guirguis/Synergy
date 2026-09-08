import { useState } from 'react';
import type { ReactNode } from 'react';
import { DataTable } from '../datatable/DataTable';
import type { DataTableProps, ColumnDefinition, BulkAction } from './types/ui';
import './BaseList.css';

export interface BaseListProps<T> {
  // Toolbar
  title?: string;
  onCreateClick?: () => void;
  onExportClick?: () => void;
  toolbarContent?: ReactNode;

  // Collapsible filter panel
  filters?: ReactNode;
  /** Filter panel starts expanded instead of collapsed (default: false) */
  defaultFiltersOpen?: boolean;

  // Data
  data: T[];
  columns: ColumnDefinition<T>[];
  loading?: boolean;
  error?: string;
  emptyMessage?: string;

  // Row actions
  onView?: (item: T) => void;
  onPreview?: (item: T) => void;
  onEdit?: (item: T) => void;
  onDelete?: (item: T) => void;
  onSelect?: (selected: T[]) => void;
  /** Click handler for the whole row — opens record without showing an action button */
  onRowClick?: (item: T) => void;
  bulkActions?: BulkAction<T>[];
  pagination?: DataTableProps<T>['pagination'];

  // Table options
  responsive?: boolean;
  striped?: boolean;
  hoverable?: boolean;
  className?: string;

  /** @deprecated No longer rendered — use onCreateClick/onExportClick instead */
  headerActions?: ReactNode;
  /** @deprecated No longer rendered */
  stats?: ReactNode;
}

/**
 * Base List Component
 *
 * Provides a consistent list layout with:
 * - Toolbar: module title (left), filter toggle, export icon, + New button (right)
 * - Collapsible filter panel
 * - Data table
 *
 * All module lists should use this component.
 */
export function BaseList<T extends Record<string, any>>({
  title,
  onCreateClick,
  onExportClick,
  toolbarContent,
  filters,
  defaultFiltersOpen = false,
  data,
  columns,
  loading,
  error,
  emptyMessage,
  onView,
  onPreview,
  onEdit,
  onDelete,
  onSelect,
  onRowClick,
  bulkActions,
  pagination,
  responsive = true,
  striped = true,
  hoverable = true,
  className = '',
}: BaseListProps<T>) {
  const [showFilters, setShowFilters] = useState(defaultFiltersOpen);

  const hasToolbar = title || onCreateClick || onExportClick || toolbarContent || filters;

  return (
    <div className={`base-list ${className}`}>
      {hasToolbar && (
        <div className="base-list__toolbar">
          {title && <div className="base-list__toolbar-title">{title}</div>}

          {toolbarContent}

          {filters && (
            <button
              type="button"
              className={`base-list__toolbar-btn base-list__toolbar-btn--filter${showFilters ? ' base-list__toolbar-btn--active' : ''}`}
              onClick={() => setShowFilters(!showFilters)}
              title={showFilters ? 'Hide filters' : 'Show filters'}
            >
              <i className="material-symbols-outlined">filter_list</i>
              Filter
            </button>
          )}

          {onExportClick && (
            <button
              type="button"
              className="base-list__toolbar-btn base-list__toolbar-btn--export"
              onClick={onExportClick}
              title="Export"
            >
              <i className="material-symbols-outlined">download</i>
            </button>
          )}

          {onCreateClick && (
            <button
              type="button"
              className="base-list__toolbar-btn base-list__toolbar-btn--new"
              onClick={onCreateClick}
            >
              + New
            </button>
          )}
        </div>
      )}

      {showFilters && filters && (
        <div className="base-list__filters-panel">
          {filters}
        </div>
      )}

      <DataTable
        data={data}
        columns={columns}
        loading={loading}
        error={error}
        emptyMessage={emptyMessage}
        onView={onView}
        onPreview={onPreview}
        onEdit={onEdit}
        onDelete={onDelete}
        onSelect={onSelect}
        onRowClick={onRowClick}
        bulkActions={bulkActions}
        pagination={pagination}
        responsive={responsive}
        striped={striped}
        hoverable={hoverable}
      />
    </div>
  );
}

export default BaseList;
