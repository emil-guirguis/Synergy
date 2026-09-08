/**
 * List Component Framework - useBaseList Hook
 * 
 * Core hook that provides standardized list functionality including:
 * - State management (search, filters, modals)
 * - Permission and feature flag logic
 * - Data fetching and lifecycle
 * - CRUD handlers
 * - Bulk actions
 * - Export/Import functionality
 * - Render helpers for UI components
 * 
 * @example
 * const baseList = useBaseList<Contact, ReturnType<typeof useContactsEnhanced>>({
 *   entityName: 'contact',
 *   entityNamePlural: 'contacts',
 *   useStore: useContactsEnhanced,
 *   columns: contactColumns,
 *   filters: contactFilters,
 *   permissions: {
 *     create: Permission.CONTACT_CREATE,
 *     update: Permission.CONTACT_UPDATE,
 *     delete: Permission.CONTACT_DELETE,
 *   },
 *   authContext: useAuth(), // Optional: provide auth context
 * });
 */

import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useSchema } from '../../form/utils/schemaLoader';
import type {
  BaseListConfig,
  BaseListReturn,
  EnhancedStore,
  AuthContextProvider,
} from '../types/list';
import type { BulkAction, PaginationConfig } from '../types/ui';
import { debounceSearch, buildFilters } from '../utils/listHelpers';
import { ConfirmationModal } from '../../../components/modal';
import { generateCSV, downloadCSV, formatDateForFilename, generateExportInfo } from '../utils/exportHelpers';
import { processImportFile, generateImportTemplate } from '../utils/importHelpers';
import { getIconElement, MaterialIcons } from '../../../utils/iconHelper';

// Default auth context that always returns false for permissions
const defaultAuthContext: AuthContextProvider = {
  checkPermission: () => false,
  user: undefined,
};

// Create a React Context for auth (optional fallback)
const AuthContext = createContext<AuthContextProvider>(defaultAuthContext);

/**
 * useBaseList Hook
 * 
 * Provides comprehensive list management functionality with type safety.
 * Combines feature flags and permissions to control UI visibility and actions.
 * 
 * @template T - Entity type (e.g., Contact, User, Meter)
 * @template StoreType - Store type that extends EnhancedStore<T>
 * @param config - Configuration object for the list
 * @returns Object containing state, handlers, and render helpers
 */
export function useBaseList<T extends Record<string, any>, StoreType extends EnhancedStore<T>>(
  config: BaseListConfig<T, StoreType>
): BaseListReturn<T> {
  const {
    entityName,
    entityNamePlural,
    useStore,
    features = {},
    permissions = {},
    columns,
    filters: filterDefinitions = [],
    stats: statDefinitions = [],
    bulkActions: bulkActionConfigs = [],
    export: exportConfig,
    import: importConfig,
    authContext: providedAuthContext,
    onEdit,
    onCreate,
  } = config;

  // Get auth context - use provided context or fall back to React Context
  const contextAuthContext = useContext(AuthContext);
  const authContext = providedAuthContext || contextAuthContext;
  const { checkPermission } = authContext;

  // Get store instance
  const store = useStore();

  // Track whether the [filters] effect has run at least once (to skip the empty initial run).
  const filtersInitialisedRef = useRef(false);
  // Track the last filter key that was fetched so we only bypass cache when filters
  // actually change. This prevents React Strict Mode's double-invocation from issuing
  // a second DB round-trip (same filters → cache hit instead of bypass).
  const lastFetchedFiltersKeyRef = useRef<string | null>(null);

  // Load entity schema to determine special behaviors (e.g., soft-delete via `active` flag)
  const { schema: entitySchema, loading: schemaLoading } = useSchema(entityName);

  // State management
  const [searchQuery, setSearchQueryState] = useState('');
  const [filters, setFiltersState] = useState<Record<string, any>>({});
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    isOpen: boolean;
    item: T | null;
    itemName: string;
  }>({ isOpen: false, item: null, itemName: '' });

  // Memoize columns to prevent unnecessary re-renders
  const memoizedColumns = useMemo(() => columns, [columns]);

  // Memoize filter definitions
  const memoizedFilterDefinitions = useMemo(() => filterDefinitions, [filterDefinitions]);

  // Memoize stat definitions
  const memoizedStatDefinitions = useMemo(() => statDefinitions, [statDefinitions]);

  // Memoize bulk action configs - ensure it's always an array
  const memoizedBulkActionConfigs = useMemo(() => {
    return Array.isArray(bulkActionConfigs) ? bulkActionConfigs : [];
  }, [bulkActionConfigs]);

  // Create debounced search handler - routes through filter pipeline for unified handling
  const debouncedSetSearch = useMemo(
    () => debounceSearch((query: string) => {
      console.log('[useBaseList] Debounced search called with query:', query);
      // Route search through filter pipeline so it triggers fetchItems like other filters
      setFiltersState(prev => {
        const updated = { ...prev, search: query };
        console.log('[useBaseList] Search routed to filters:', updated);
        return updated;
      });
    }, 300),
    []
  );

  // Feature flags with defaults
  const {
    allowCreate = true,
    allowEdit = true,
    allowDelete = true,
    allowBulkActions = true,
    allowExport = true,
    allowImport = false,
    allowSearch = true,
    allowFilters = true,
    allowStats = true,
    allowPagination = true,
  } = features;

  // Computed permission values (combines features + permissions)
  const canCreate = useMemo(
    () => allowCreate && (!permissions.create || checkPermission(permissions.create)),
    [allowCreate, permissions.create, checkPermission]
  );

  const canUpdate = useMemo(
    () => allowEdit && (!permissions.update || checkPermission(permissions.update)),
    [allowEdit, permissions.update, checkPermission]
  );

  const canDelete = useMemo(
    () => allowDelete && (!permissions.delete || checkPermission(permissions.delete)),
    [allowDelete, permissions.delete, checkPermission]
  );

  const canExport = useMemo(() => allowExport, [allowExport]);

  const canImport = useMemo(
    () => allowImport && (!permissions.create || checkPermission(permissions.create)),
    [allowImport, permissions.create, checkPermission]
  );

  const canBulkAction = useMemo(() => allowBulkActions, [allowBulkActions]);

  // Initialize default 'active' filter and fetch data.
  // Waits for schema to load so filterDefinitions are accurate before deciding.
  useEffect(() => {
    if (schemaLoading) return;

    const hasActiveFilter = memoizedFilterDefinitions.some(f => f.key === 'active');

    // Don't override filters already set (e.g. user navigated back with existing filters)
    if (Object.keys(filters).length > 0) {
      return;
    }

    if (hasActiveFilter) {
      // Set default active=true filter. The [filters] effect will fire when this state
      // update lands and will issue the actual fetch — don't fetch here.
      console.log('[useBaseList] Initializing default active filter to true');
      const defaultFilters = { active: 'true' };
      setFiltersState(defaultFilters);
      if (store.setFilters) {
        store.setFilters(defaultFilters);
      }
    } else {
      // No active filter default — [filters] effect skips its first run (empty filters),
      // so we must trigger the initial fetch ourselves.
      console.log('[useBaseList] No active filter, fetching all items');
      if (store.fetchItems) {
        store.fetchItems();
      }
    }
  }, [memoizedFilterDefinitions, schemaLoading]);

  // Apply filters when they change
  useEffect(() => {
    console.log('[useBaseList] Filter effect triggered with filters:', filters);

    // Schema hasn't loaded yet — defer to the [memoizedFilterDefinitions, schemaLoading]
    // effect which fires once schema is ready and sets the correct default filters.
    if (schemaLoading) {
      console.log('[useBaseList] Schema loading — deferring filter init');
      return;
    }

    if (!filtersInitialisedRef.current) {
      // Schema is loaded but this is the very first run of [filters].
      // The [filterDefs+schemaLoading] effect will handle the initial fetch.
      filtersInitialisedRef.current = true;
      console.log('[useBaseList] Initial filter run — deferring fetch to filter initialisation');
      return;
    }

    if (store.setFilters && store.fetchItems) {
      const cleanedFilters = buildFilters(filters);
      console.log('[useBaseList] Setting cleaned filters:', cleanedFilters);
      store.setFilters(cleanedFilters);

      // Only bypass cache when the filters actually changed from the last fetch.
      // Using the same key (e.g. React Strict Mode re-running the same effect) hits
      // the TTL cache instead of firing another DB query.
      // Note: `null` (this ref's un-set state) must count as "changed" too — for
      // entities with no default 'active' filter, the initial load fetches via
      // store.fetchItems() directly (see the effect above) without ever touching
      // this ref, so it's still null when the user's first filter/search lands here.
      // Treating null as "unchanged" made that first filter action a no-op: it hit
      // the now-warm post-initial-load cache and silently returned stale data.
      const filtersKey = JSON.stringify(cleanedFilters);
      const filtersChanged = lastFetchedFiltersKeyRef.current !== filtersKey;
      lastFetchedFiltersKeyRef.current = filtersKey;

      if (filtersChanged) {
        console.log('[useBaseList] Filters changed — bypassing cache');
        (store.fetchItems as any)({ _bypassCache: true });
      } else {
        console.log('[useBaseList] Initial or same filters — respecting cache');
        store.fetchItems();
      }
    }
  }, [filters, schemaLoading]);

  // State setters with store integration
  const setSearchQuery = useCallback((query: string) => {
    setSearchQueryState(query);
    debouncedSetSearch(query);
  }, [debouncedSetSearch]);

  const setFilter = useCallback((key: string, value: any) => {
    console.log('[useBaseList] setFilter called with key:', key, 'value:', value);
    setFiltersState(prev => {
      const newFilters = { ...prev, [key]: value };
      console.log('[useBaseList] Updated filters state:', newFilters);
      return newFilters;
    });
  }, []);

  const clearFilters = useCallback(() => {
    console.log('[useBaseList] clearFilters called');
    setFiltersState({});
    setSearchQueryState('');

    // Clear store filters - search is now part of filters, so this clears both
    if (store.setFilters) {
      store.setFilters({});
    }
    // Keep store.setSearch for backward compatibility (no harm in calling it)
    if (store.setSearch) {
      store.setSearch('');
    }

    // Trigger new API request to fetch all data
    if (store.fetchItems) {
      store.fetchItems();
    }
  }, []);

  // CRUD handlers
  const handleEdit = useCallback((item: T) => {
    console.log('[useBaseList] handleEdit called with item:', item);
    
    // Validate item has required properties
    if (!item || typeof item !== 'object') {
      console.error('[useBaseList] Invalid item passed to handleEdit:', item);
      return;
    }
    
    // Check permissions
    if (!canUpdate) {
      console.warn('[useBaseList] Edit not allowed - missing permission');
      return;
    }
    
    // Invoke callback with complete item
    if (onEdit) {
      console.log('[useBaseList] Invoking onEdit callback');
      onEdit(item);
    } else {
      console.warn('[useBaseList] No onEdit callback provided');
    }
  }, [canUpdate, onEdit]);

  const handleDelete = useCallback(async (item: T) => {
    // Temporarily bypass permission check for debugging
    // if (!canDelete) return;

    // Get item name for confirmation message
    const itemName = (item as any).name || (item as any).title || (item as any).id || 'this item';
    
    // Show confirmation modal
    setDeleteConfirmation({
      isOpen: true,
      item,
      itemName: String(itemName)
    });
  }, [canDelete]);

  const confirmDelete = useCallback(async () => {
    const { item } = deleteConfirmation;
    if (!item) return;

    try {
      const hasActiveFlag = !!(entitySchema && entitySchema.entityFields && entitySchema.entityFields.active);

      if (hasActiveFlag && store.updateItem) {
        // Toggle the active flag instead of deleting the record
        const currentActive = (item as any).active === undefined ? false : Boolean((item as any).active);
        await store.updateItem((item as any).id, { active: !currentActive });
        if (store.fetchItems) {
          await store.fetchItems();
        }
      } else if (store.deleteItem) {
        // Fallback to hard delete if no active flag or update not available
        await store.deleteItem((item as any).id);
        if (store.fetchItems) {
          await store.fetchItems();
        }
      } else {
        throw new Error(`Delete operation not supported for ${entityNamePlural}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to delete ${entityName}`;
      alert(message); // TODO: Replace with toast notification system
      console.error('Delete error:', error);
    } finally {
      setDeleteConfirmation({ isOpen: false, item: null, itemName: '' });
    }
  }, [deleteConfirmation, entityName, entityNamePlural, store.deleteItem, store.fetchItems]);

  const cancelDelete = useCallback(() => {
    setDeleteConfirmation({ isOpen: false, item: null, itemName: '' });
  }, []);

  const handleCreate = useCallback(() => {
    if (!canCreate) return;
    onCreate?.();
  }, [canCreate, onCreate]);

  // Export functionality
  const handleExport = useCallback((items: T[]) => {
    if (!canExport || !exportConfig) {
      console.warn('Export is not configured or not allowed');
      return;
    }

    try {
      // Generate filename with current date
      const dateStr = formatDateForFilename();
      const filename = exportConfig.filename(dateStr);

      // Map items to CSV rows
      const rows = items.map(item => exportConfig.mapRow(item));

      // Generate info text if provided
      const info = exportConfig.includeInfo 
        ? generateExportInfo(entityNamePlural, items.length)
        : undefined;

      // Generate and download CSV
      const csvContent = generateCSV(exportConfig.headers, rows, info);
      downloadCSV(csvContent, filename);

      // Close export modal if open
      setShowExportModal(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed';
      alert(message); // TODO: Replace with toast notification system
      console.error('Export error:', error);
    }
  }, [canExport, exportConfig, entityNamePlural]);

  const handleExportAll = useCallback(() => {
    if (!canExport || !exportConfig) {
      console.warn('Export is not configured or not allowed');
      return;
    }

    // Export all items from store
    const allItems = store.items || [];
    handleExport(allItems);
  }, [canExport, exportConfig, store.items, handleExport]);

  // Import functionality
  const handleImport = useCallback(async (file: File) => {
    if (!canImport || !importConfig) {
      console.warn('Import is not configured or not allowed');
      return;
    }

    try {
      // Process the import file
      const { rows } = await processImportFile(
        file,
        importConfig.templateHeaders,
        importConfig.validateRow,
        importConfig.maxFileSize,
        importConfig.allowedExtensions
      );

      // Map rows to entities
      const items = rows.map(row => importConfig.mapRow(row));

      // Process import
      const result = await importConfig.onImport(items);

      // Show result to user
      if (result.success) {
        alert(`Successfully imported ${result.imported} ${entityNamePlural}${result.failed > 0 ? `. ${result.failed} items failed.` : ''}`);
        
        // Refresh data after import
        if (store.fetchItems) {
          await store.fetchItems();
        }
        
        // Close import modal
        setShowImportModal(false);
      } else {
        // Show errors
        const errorMessage = result.errors && result.errors.length > 0
          ? `Import failed:\n${result.errors.map(e => `Row ${e.row}: ${e.message}`).join('\n')}`
          : 'Import failed';
        alert(errorMessage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed';
      alert(message); // TODO: Replace with toast notification system
      console.error('Import error:', error);
    }
  }, [canImport, importConfig, entityNamePlural, store.fetchItems]);

  // Helper to download import template
  const handleDownloadTemplate = useCallback(() => {
    if (!importConfig) {
      console.warn('Import is not configured');
      return;
    }

    generateImportTemplate(
      importConfig.templateFilename,
      importConfig.templateHeaders,
      undefined, // No example rows by default
      importConfig.instructions
    );
  }, [importConfig]);

  // Render helper methods - memoized to prevent unnecessary re-renders
  const renderFilters = useCallback((): ReactNode => {
    if (!allowFilters || memoizedFilterDefinitions.length === 0) {
      return null;
    }

    return (
      <>
        {allowSearch && (
          <div className="list__filter-item list__filter-item--search">
            <input
              type="text"
              className="form-control"
              placeholder={`Search...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label={`Search ${entityNamePlural}`}
            />
          </div>
        )}
        
        {memoizedFilterDefinitions.map((filter) => {
          const filterValue = filters[filter.key] || '';
          
          if (filter.type === 'select') {
            // Get options
            const options = typeof filter.options === 'function'
              ? filter.options(store.items || [])
              : filter.options || [];

            return (
              <div key={filter.key} className={`list__filter-item ${filter.className || ''}`}>
                <select
                  className="form-control"
                  value={filterValue}
                  onChange={(e) => setFilter(filter.key, e.target.value)}
                  aria-label={filter.label}
                  disabled={filter.disabled}
                >
                  {filter.key !== 'active' && !filter.disabled && (
                    <option value="">{filter.placeholder || `All ${filter.label}`}</option>
                  )}
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          }

          if (filter.type === 'text') {
            return (
              <div key={filter.key} className={`list__filter-item ${filter.className || ''}`}>
                <input
                  type="text"
                  className="form-control"
                  placeholder={filter.placeholder || filter.label}
                  value={filterValue}
                  onChange={(e) => setFilter(filter.key, e.target.value)}
                />
              </div>
            );
          }

          if (filter.type === 'date') {
            return (
              <div key={filter.key} className={`list__filter-item ${filter.className || ''}`}>
                <input
                  type="date"
                  className="form-control"
                  placeholder={filter.placeholder || filter.label}
                  value={filterValue}
                  onChange={(e) => setFilter(filter.key, e.target.value)}
                />
              </div>
            );
          }

          // Return null with key for unsupported filter types
          return <React.Fragment key={filter.key} />;
        })}

        {(searchQuery || Object.keys(buildFilters(filters)).length > 0) && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={clearFilters}
            aria-label="Clear all filters"
          >
            Clear Filters
          </button>
        )}
      </>
    );
  }, [
    allowFilters,
    allowSearch,
    memoizedFilterDefinitions,
    searchQuery,
    filters,
    entityNamePlural,
    store.items,
    setSearchQuery,
    setFilter,
    clearFilters,
  ]);

  const renderHeaderActions = useCallback((): ReactNode => {
    const actions: ReactNode[] = [];

    // Create link
    if (canCreate) {
      actions.push(
        <button
          key="create"
          type="button"
          onClick={handleCreate}
          aria-label={`Add new ${entityName}`}
        >
          {getIconElement(MaterialIcons.ADD)} Add {entityName}
        </button>
      );
    }

    // Export link
    if (canExport && exportConfig) {
      actions.push(
        <button
          key="export"
          type="button"
          onClick={() => setShowExportModal(true)}
          aria-label={`Export ${entityNamePlural} to CSV`}
        >
          {getIconElement(MaterialIcons.TABLE_CHART)} Export CSV
        </button>
      );
    }

    // Import link
    if (canImport && importConfig) {
      actions.push(
        <button
          key="import"
          type="button"
          onClick={() => setShowImportModal(true)}
          aria-label={`Import ${entityNamePlural} from CSV`}
        >
          {getIconElement(MaterialIcons.UPLOAD)} Import CSV
        </button>
      );
    }

    return actions.length > 0 ? (
      <div className="list__header-actions">
        {actions}
      </div>
    ) : null;
  }, [
    canCreate,
    canExport,
    canImport,
    exportConfig,
    importConfig,
    entityName,
    entityNamePlural,
    handleCreate,
  ]);

  const renderStats = useCallback((): ReactNode => {
    if (!allowStats || memoizedStatDefinitions.length === 0) {
      return null;
    }

    return (
      <div className="list__stats">
        {memoizedStatDefinitions.map((stat, index) => {
          const value = stat.value(store.items || [], store);
          const formattedValue = stat.format ? stat.format(value) : String(value);

          return (
            <div key={index} className="list__stat-item">
              <div className="list__stat-label">{stat.label}</div>
              <div className="list__stat-value">{formattedValue}</div>
            </div>
          );
        })}
      </div>
    );
  }, [allowStats, memoizedStatDefinitions, store]);

  const renderExportModal = useCallback((): ReactNode => {
    if (!showExportModal || !exportConfig) {
      return null;
    }

    const itemCount = store.items?.length || 0;

    return (
      <div 
        className="modal-overlay" 
        onClick={() => setShowExportModal(false)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
      >
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3 id="export-modal-title">Export {entityNamePlural}</h3>
            <button
              type="button"
              className="modal-close"
              onClick={() => setShowExportModal(false)}
              aria-label="Close export modal"
            >
              ×
            </button>
          </div>
          <div className="modal-body">
            <p>
              Export all {itemCount} {itemCount === 1 ? entityName : entityNamePlural} to CSV format.
            </p>
            {exportConfig.includeInfo && (
              <p className="text-muted">
                The export will include metadata and timestamp information.
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowExportModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleExportAll}
            >
              <i className="icon-download"></i> Export
            </button>
          </div>
        </div>
      </div>
    );
  }, [
    showExportModal,
    exportConfig,
    entityName,
    entityNamePlural,
    store.items,
    handleExportAll,
  ]);

  const renderImportModal = useCallback((): ReactNode => {
    if (!showImportModal || !importConfig) {
      return null;
    }

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleImport(file);
      }
    };

    return (
      <div 
        className="modal-overlay" 
        onClick={() => setShowImportModal(false)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
      >
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3 id="import-modal-title">Import {entityNamePlural}</h3>
            <button
              type="button"
              className="modal-close"
              onClick={() => setShowImportModal(false)}
              aria-label="Close import modal"
            >
              ×
            </button>
          </div>
          <div className="modal-body">
            {importConfig.instructions && (
              <p className="import-instructions">{importConfig.instructions}</p>
            )}
            
            <div className="import-template">
              <p>
                <strong>Step 1:</strong> Download the template file
              </p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleDownloadTemplate}
              >
                <i className="icon-download"></i> Download Template
              </button>
            </div>

            <div className="import-upload">
              <p>
                <strong>Step 2:</strong> Upload your completed CSV file
              </p>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileSelect}
                className="form-control"
                aria-label={`Upload ${entityNamePlural} CSV file`}
              />
            </div>

            <div className="import-notes">
              <p className="text-muted">
                <small>
                  Maximum file size: {((importConfig.maxFileSize || 5242880) / 1048576).toFixed(1)}MB
                  <br />
                  Allowed formats: {(importConfig.allowedExtensions || ['.csv']).join(', ')}
                </small>
              </p>
            </div>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowImportModal(false)}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }, [
    showImportModal,
    importConfig,
    entityNamePlural,
    handleImport,
    handleDownloadTemplate,
  ]);

  // Processed bulk actions (filtered by permissions) - memoized for performance
  const bulkActions: BulkAction<T>[] = useMemo(() => {
    if (!canBulkAction || memoizedBulkActionConfigs.length === 0) {
      return [];
    }

    // Filter bulk actions based on permissions
    return memoizedBulkActionConfigs
      .filter(actionConfig => {
        // If action requires permission, check it
        if (actionConfig.requirePermission) {
          return checkPermission(actionConfig.requirePermission);
        }
        return true;
      })
      .map(actionConfig => ({
        id: actionConfig.id,
        label: actionConfig.label,
        icon: actionConfig.icon,
        color: actionConfig.color,
        confirm: actionConfig.confirm,
        confirmMessage: typeof actionConfig.confirmMessage === 'function' 
          ? undefined 
          : actionConfig.confirmMessage,
        action: async (selectedItems: T[]) => {
          try {
            // Handle confirmation if required
            if (actionConfig.confirm) {
              const message = typeof actionConfig.confirmMessage === 'function'
                ? actionConfig.confirmMessage(selectedItems)
                : actionConfig.confirmMessage || `Are you sure you want to perform this action on ${selectedItems.length} ${selectedItems.length === 1 ? entityName : entityNamePlural}?`;
              
              const confirmed = window.confirm(message);
              if (!confirmed) return;
            }

            // Execute the action
            await actionConfig.action(selectedItems, store);

            // Refresh data after action
            if (store.fetchItems) {
              await store.fetchItems();
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Bulk action failed';
            alert(message); // TODO: Replace with toast notification system
            console.error('Bulk action error:', error);
          }
        },
      }));
  }, [canBulkAction, memoizedBulkActionConfigs, checkPermission, entityName, entityNamePlural, store, store.fetchItems]);

  // Pagination configuration
  const pagination: PaginationConfig = useMemo(() => {
    if (!allowPagination || !store.list) {
      return {
        currentPage: 1,
        pageSize: 25,
        total: 0,
        onPageChange: () => {},
        onPageSizeChange: () => {},
      };
    }

    return {
      currentPage: store.list.page || 1,
      pageSize: store.list.pageSize || 25,
      total: store.list.total || store.items?.length || 0,
      pageSizeOptions: [10, 25, 50, 100],
      showSizeChanger: true,
      onPageChange: (page: number) => {
        if (store.setPage) {
          store.setPage(page);
          // setPage only mutates list.page — nothing refetches on its own.
          // Rows are server-paginated, so trigger a fetch for the new page.
          // Bypass cache: same entity, different offset — cached page is stale here.
          if (store.fetchItems) {
            (store.fetchItems as any)({ _bypassCache: true });
          }
        }
      },
      onPageSizeChange: (pageSize: number) => {
        if (store.setPageSize) {
          store.setPageSize(pageSize);
          if (store.fetchItems) {
            (store.fetchItems as any)({ _bypassCache: true });
          }
        }
      },
    };
  }, [allowPagination, store.list, store.setPage, store.setPageSize, store.fetchItems]);

  // Memoize data to prevent unnecessary re-renders
  const memoizedData = useMemo(() => store.items || [], [store.items]);

  // Memoize loading and error states
  const loading = useMemo(() => store.list?.loading || false, [store.list?.loading]);
  const error = useMemo(() => store.list?.error || undefined, [store.list?.error]);

  // Return hook interface
  return {
    // State
    searchQuery,
    filters,
    showExportModal,
    showImportModal,

    // Setters
    setSearchQuery,
    setFilter,
    clearFilters,
    setShowExportModal,
    setShowImportModal,

    // Computed values
    canCreate,
    canUpdate,
    canDelete,
    canExport,
    canImport,
    canBulkAction,

    // Handlers
    handleEdit,
    handleDelete,
    handleCreate,
    handleExport,
    handleExportAll,
    handleImport,

    // Render helpers
    renderFilters,
    renderHeaderActions,
    renderStats,
    renderExportModal,
    renderImportModal,
    renderDeleteConfirmation: () => {
      const hasActiveFlag = !!(entitySchema && entitySchema.entityFields && entitySchema.entityFields.active);
      const isActive = deleteConfirmation.item ? Boolean((deleteConfirmation.item as any).active) : true;
      const title = hasActiveFlag ? (isActive ? `Deactivate ${entityName}` : `Activate ${entityName}`) : `Delete ${entityName}`;
      const message = hasActiveFlag
        ? `Are you sure you want to ${isActive ? 'deactivate' : 'activate'} ${entityName} "${deleteConfirmation.itemName}"? This will ${isActive ? 'prevent' : 'allow'} it from appearing in active lists.`
        : `Are you sure you want to delete ${entityName} "${deleteConfirmation.itemName}"? This action cannot be undone.`;
      const confirmText = hasActiveFlag ? (isActive ? 'Deactivate' : 'Activate') : 'Delete';
      const modalType = hasActiveFlag ? 'warning' : 'danger';

      return (
        <ConfirmationModal
          isOpen={deleteConfirmation.isOpen}
          title={title}
          message={message}
          confirmText={confirmText}
          cancelText="Cancel"
          type={modalType}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      );
    },

    // Data
    columns: memoizedColumns,
    bulkActions,
    data: memoizedData,
    loading,
    error,
    pagination,
  };
}

// Export the AuthContext for projects to provide their auth implementation
export { AuthContext };
