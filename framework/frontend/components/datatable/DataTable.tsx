import { useState, useMemo, useCallback, useEffect } from 'react';
import type { DataTableProps, ColumnDefinition, BulkAction } from '../list/types/ui';
import { useResponsive } from '../../hooks/useResponsive';
import './DataTable.css';

export function DataTable<T extends Record<string, any>>({
  data,
  columns,
  loading = false,
  error,
  emptyMessage = 'No data available',
  onEdit,
  onDelete,
  onView,
  onPreview,
  onRowClick,
  onSelect,
  pagination,
  bulkActions = [],
  responsive = true,
  striped = true,
  hoverable = true,
  sortBy,
  sortOrder,
}: DataTableProps<T>) {
  const { isMobile, isTablet } = useResponsive();
  const [selectedItems, setSelectedItems] = useState<T[]>([]);
  const [sortConfig, setSortConfig] = useState<{
    key: string;
    direction: 'asc' | 'desc';
  } | null>(sortBy ? { key: sortBy, direction: sortOrder === 'asc' ? 'asc' : 'desc' } : null);

  // sortBy/sortOrder reflect the server-applied sort (e.g. schema.defaultSortBy),
  // which typically only becomes known after the schema loads asynchronously —
  // sync it in once it arrives rather than only seeding initial state.
  useEffect(() => {
    if (sortBy) {
      setSortConfig({ key: sortBy, direction: sortOrder === 'asc' ? 'asc' : 'desc' });
    }
  }, [sortBy, sortOrder]);
  const [pageInputValue, setPageInputValue] = useState<string>(
    String(pagination?.currentPage ?? 1)
  );

  // Keep input in sync when page changes externally
  useEffect(() => {
    setPageInputValue(String(pagination?.currentPage ?? 1));
  }, [pagination?.currentPage]);

  const totalPages = pagination
    ? Math.ceil(pagination.total / pagination.pageSize)
    : 1;

  const commitPageInput = () => {
    if (!pagination) return;
    const n = parseInt(pageInputValue, 10);
    if (!isNaN(n) && n >= 1 && n <= totalPages) {
      pagination.onPageChange(n);
    } else {
      setPageInputValue(String(pagination.currentPage));
    }
  };

  // Handle sorting
  const handleSort = useCallback((key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  }, [sortConfig]);

  // Sort data
  const sortedData = useMemo(() => {
    if (!Array.isArray(data)) return [];
    if (!sortConfig) return data;
    
    return [...data].sort((a, b) => {
      const aValue = a[sortConfig.key];
      const bValue = b[sortConfig.key];
      
      if (aValue < bValue) {
        return sortConfig.direction === 'asc' ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortConfig.direction === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }, [data, sortConfig]);

  // Handle selection
  const handleSelectAll = useCallback((checked: boolean) => {
    const newSelection = checked ? [...sortedData] : [];
    setSelectedItems(newSelection);
    onSelect?.(newSelection);
  }, [sortedData, onSelect]);

  const handleSelectItem = useCallback((item: T, checked: boolean) => {
    const newSelection = checked
      ? [...selectedItems, item]
      : selectedItems.filter(selected => selected.id !== item.id);
    
    setSelectedItems(newSelection);
    onSelect?.(newSelection);
  }, [selectedItems, onSelect]);

  // Handle bulk actions
  const handleBulkAction = useCallback(async (action: BulkAction<T>) => {
    if (selectedItems.length === 0) return;
    
    if (action.confirm) {
      const confirmed = window.confirm(
        action.confirmMessage || `Are you sure you want to ${action.label.toLowerCase()} ${selectedItems.length} item(s)?`
      );
      if (!confirmed) return;
    }
    
    try {
      await action.action(selectedItems);
      setSelectedItems([]);
      onSelect?.([]);
    } catch (error) {
      console.error('Bulk action failed:', error);
    }
  }, [selectedItems, onSelect]);

  // Get visible columns based on responsive settings.
  // Mobile card view shows all columns (the card layout handles space).
  // On tablet, hide columns marked hide-tablet. On desktop, show everything.
  const visibleColumns = useMemo(() => {
    if (!responsive || isMobile) return columns;

    return columns.filter(column => {
      if (!column.responsive) return true;
      if (column.responsive === 'always-show') return true;
      if (column.responsive === 'hide-mobile') return true;   // only hidden on mobile
      if (column.responsive === 'hide-tablet') return !isTablet; // hidden on tablet, shown on desktop
      return true;
    });
  }, [columns, responsive, isMobile, isTablet]);

  // Render cell content
  const renderCell = useCallback((column: ColumnDefinition<T>, item: T, index: number) => {
    const key = column.key;
    const value = typeof key === 'string' && key.includes('.') 
      ? key.split('.').reduce((obj, key) => obj?.[key], item)
      : item[key as keyof T];
    
    if (column.render) {
      return column.render(value, item, index);
    }
    
    return value != null ? String(value) : '';
  }, []);

  // Render action buttons
  const renderActions = useCallback((item: T) => {
    const hasActions = onView || onPreview || onEdit || onDelete;
    if (!hasActions) return null;

    console.log('[DataTable] Rendering actions for item:', item, { onView: !!onView, onPreview: !!onPreview, onEdit: !!onEdit, onDelete: !!onDelete });

    return (
      <div className="data-table__actions">
        {onView && (
          <button
            type="button"
            className="data-table__action-btn data-table__action-btn--view"
            onClick={(e) => {
              e.stopPropagation();
              onView(item);
            }}
            title="View"
          >
            <span className="material-symbols-outlined" aria-hidden="true">visibility</span>
          </button>
        )}
        {onPreview && (
          <button
            type="button"
            className="data-table__action-btn data-table__action-btn--preview"
            onClick={(e) => {
              e.stopPropagation();
              onPreview(item);
            }}
            title="Preview Report"
          >
            <span className="material-symbols-outlined" aria-hidden="true">preview</span>
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            className="data-table__action-btn data-table__action-btn--edit"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(item);
            }}
            title="Edit"
          >
            <span className="material-symbols-outlined" aria-hidden="true">edit</span>
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="data-table__action-btn data-table__action-btn--delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(item);
            }}
            title="Delete"
          >
            <span className="material-symbols-outlined" aria-hidden="true">delete</span>
          </button>
        )}
      </div>
    );
  }, [onView, onPreview, onEdit, onDelete]);

  // Error state
  if (error) {
    return (
      <div className="data-table__error">
        <p>Error: {error}</p>
      </div>
    );
  }

  // Check if data is empty
  const isEmpty = !data || data.length === 0;

  // Mobile card view
  if (responsive && isMobile) {
    return (
      <div className="data-table data-table--mobile">
        {/* Bulk actions for mobile */}
        {bulkActions.length > 0 && selectedItems.length > 0 && (
          <div className="data-table__bulk-actions">
            <span className="data-table__selected-count">
              {selectedItems.length} selected
            </span>
            {bulkActions.map(action => (
              <button
                key={action.id}
                type="button"
                className={`data-table__bulk-btn data-table__bulk-btn--${action.color || 'primary'}`}
                onClick={() => handleBulkAction(action)}
              >
                {action.icon && <span className="data-table__bulk-icon">{action.icon}</span>}
                {action.label}
              </button>
            ))}
          </div>
        )}

        <div className="data-table__cards">
          {loading && (!data || data.length === 0) ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="data-table__card data-table__card--skeleton">
                {visibleColumns.map(column => (
                  <div key={column.key?.toString()} className="data-table__card-field">
                    <div className="data-table__skeleton-cell data-table__skeleton-cell--label" />
                    <div className="data-table__skeleton-cell" />
                  </div>
                ))}
              </div>
            ))
          ) : isEmpty ? (
            <div className="data-table__empty">
              <p>{emptyMessage}</p>
            </div>
          ) : (
            sortedData.map((item, index) => (
              <div
                key={item.id || index}
                className={`data-table__card ${(onRowClick || onView || onEdit) ? 'data-table__card--clickable' : ''}`}
                onClick={(onRowClick || onView || onEdit) ? () => (onRowClick ?? onView ?? onEdit)!(item) : undefined}
              >
                {onSelect && (
                  <div className="data-table__card-select">
                    <input
                      type="checkbox"
                      checked={selectedItems.some(selected => selected.id === item.id)}
                      onChange={(e) => handleSelectItem(item, e.target.checked)}
                      aria-label={`Select item ${item.id || index}`}
                    />
                  </div>
                )}
                
                <div className="data-table__card-content">
                  {visibleColumns.map(column => (
                    <div key={column.key?.toString()} className="data-table__card-field">
                      <span className="data-table__card-label">{column.label}:</span>
                      <span className="data-table__card-value">
                        {renderCell(column, item, index)}
                      </span>
                    </div>
                  ))}
                </div>
                
                {renderActions(item) && (
                  <div className="data-table__card-actions">
                    {renderActions(item)}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Pagination for mobile */}
        {pagination && (
          <div className="data-table__pagination data-table__pagination--mobile">
            <button
              type="button"
              className="data-table__page-btn"
              disabled={pagination.currentPage === 1}
              onClick={() => pagination.onPageChange(pagination.currentPage - 1)}
            >
              Previous
            </button>
            <span className="data-table__page-info">
              Page{' '}
              <input
                type="text"
                className="data-table__page-input"
                value={pageInputValue}
                onChange={(e) => setPageInputValue(e.target.value)}
                onBlur={commitPageInput}
                onKeyDown={(e) => { if (e.key === 'Enter') commitPageInput(); }}
                aria-label="Current page"
              />
              {' '}of {totalPages}
            </span>
            <button
              type="button"
              className="data-table__page-btn"
              disabled={pagination.currentPage >= totalPages}
              onClick={() => pagination.onPageChange(pagination.currentPage + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    );
  }

  // Desktop table view
  return (
    <div className="data-table">
      {/* Bulk actions */}
      {bulkActions.length > 0 && selectedItems.length > 0 && (
        <div className="data-table__bulk-actions">
          <span className="data-table__selected-count">
            {selectedItems.length} selected
          </span>
          {bulkActions.map(action => (
            <button
              key={action.id}
              type="button"
              className={`data-table__bulk-btn data-table__bulk-btn--${action.color || 'primary'}`}
              onClick={() => handleBulkAction(action)}
            >
              {action.icon && <span className="data-table__bulk-icon">{action.icon}</span>}
              {action.label}
            </button>
          ))}
        </div>
      )}

      <div className="data-table__wrapper">
        <table 
          className={`
            data-table__table
            ${striped ? 'data-table__table--striped' : ''}
            ${hoverable ? 'data-table__table--hoverable' : ''}
          `.trim()}
        >
          <thead className="data-table__head">
            <tr className="data-table__row">
              {onSelect && (
                <th className="data-table__header data-table__header--select">
                  <input
                    type="checkbox"
                    checked={selectedItems.length === sortedData.length && sortedData.length > 0}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    aria-label="Select all items"
                  />
                </th>
              )}
              
              {visibleColumns.map(column => (
                <th
                  key={column.key?.toString()}
                  className={`
                    data-table__header
                    ${column.sortable ? 'data-table__header--sortable' : ''}
                    ${column.className || ''}
                  `.trim()}
                  style={{
                    width: column.width,
                    minWidth: column.minWidth,
                    textAlign: column.align || 'left'
                  }}
                  title={column.tooltip}
                  onClick={column.sortable ? () => handleSort(column.key.toString()) : undefined}
                >
                  <span className="data-table__header-content">
                    {column.label}
                    {column.sortable && sortConfig && sortConfig.key === column.key && (
                      <span className="data-table__sort-indicator">
                        {sortConfig.direction === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </span>
                </th>
              ))}
              
              {(onView || onEdit || onDelete) && (
                <th className="data-table__header data-table__header--actions">
                  {/* Empty header for actions column */}
                </th>
              )}
            </tr>
          </thead>
          
          <tbody className="data-table__body">
            {loading && (!data || data.length === 0) ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="data-table__row data-table__row--skeleton">
                  {onSelect && <td className="data-table__cell data-table__cell--select"><div className="data-table__skeleton-cell" /></td>}
                  {visibleColumns.map(column => (
                    <td key={column.key?.toString()} className="data-table__cell">
                      <div className="data-table__skeleton-cell" />
                    </td>
                  ))}
                  {(onView || onEdit || onDelete) && <td className="data-table__cell data-table__cell--actions"><div className="data-table__skeleton-cell" /></td>}
                </tr>
              ))
            ) : isEmpty ? (
              <tr className="data-table__row data-table__row--empty">
                <td
                  colSpan={
                    (onSelect ? 1 : 0) +
                    visibleColumns.length +
                    (onView || onEdit || onDelete ? 1 : 0)
                  }
                  className="data-table__cell data-table__cell--empty"
                >
                  <div className="data-table__empty">
                    <p>{emptyMessage}</p>
                  </div>
                </td>
              </tr>
            ) : (
              sortedData.map((item, index) => (
                <tr
                  key={item.id || index}
                  className={`data-table__row ${(onRowClick || onView || onEdit) ? 'data-table__row--clickable' : ''}`}
                  onClick={(onRowClick || onView || onEdit) ? () => (onRowClick ?? onView ?? onEdit)!(item) : undefined}
                >
                  {onSelect && (
                    <td className="data-table__cell data-table__cell--select">
                      <input
                        type="checkbox"
                        checked={selectedItems.some(selected => selected.id === item.id)}
                        onChange={(e) => handleSelectItem(item, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select item ${item.id || index}`}
                    />
                  </td>
                )}
                
                {visibleColumns.map(column => (
                  <td
                    key={column.key?.toString()}
                    className={`data-table__cell ${column.className || ''}`}
                    style={{ textAlign: column.align || 'left' }}
                  >
                    {renderCell(column, item, index)}
                  </td>
                ))}
                
                {(onView || onEdit || onDelete) && (
                  <td className="data-table__cell data-table__cell--actions">
                    {renderActions(item)}
                  </td>
                )}
              </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && (
        <div className="data-table__pagination">
          <div className="data-table__pagination-info">
            Showing {((pagination.currentPage - 1) * pagination.pageSize) + 1} to{' '}
            {Math.min(pagination.currentPage * pagination.pageSize, pagination.total)} of{' '}
            {pagination.total} entries
          </div>
          
          <div className="data-table__pagination-controls">
            <button
              type="button"
              className="data-table__page-btn"
              disabled={pagination.currentPage === 1}
              onClick={() => pagination.onPageChange(pagination.currentPage - 1)}
            >
              Previous
            </button>

            <span className="data-table__page-jump">
              <input
                type="text"
                className="data-table__page-input"
                value={pageInputValue}
                onChange={(e) => setPageInputValue(e.target.value)}
                onBlur={commitPageInput}
                onKeyDown={(e) => { if (e.key === 'Enter') commitPageInput(); }}
                aria-label="Current page"
              />
              <span className="data-table__page-of">of {totalPages}</span>
            </span>

            <button
              type="button"
              className="data-table__page-btn"
              disabled={pagination.currentPage >= totalPages}
              onClick={() => pagination.onPageChange(pagination.currentPage + 1)}
            >
              Next
            </button>
          </div>
          
          {pagination.showSizeChanger && (
            <div className="data-table__page-size">
              <select
                value={pagination.pageSize}
                onChange={(e) => pagination.onPageSizeChange(Number(e.target.value))}
                className="data-table__page-size-select"
                aria-label="Items per page"
              >
                {(pagination.pageSizeOptions || [10, 25, 50, 100]).map(size => (
                  <option key={size} value={size}>
                    {size} per page
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
