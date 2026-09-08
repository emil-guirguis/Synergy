// List Component Framework Type Definitions

import type { ReactNode } from 'react';
import type { Permission } from '../types/ui';
import type { ColumnDefinition, PaginationConfig, BulkAction, FilterOption } from '../types/ui';

/**
 * Feature flags control UI visibility and functionality at the component level.
 * These are independent of user permissions and used to enable/disable features
 * for specific list implementations.
 */
export interface ListFeatures {
  /** Show create button (default: true) */
  allowCreate?: boolean;
  /** Show edit actions (default: true) */
  allowEdit?: boolean;
  /** Show delete actions (default: true) */
  allowDelete?: boolean;
  /** Enable bulk actions (default: true) */
  allowBulkActions?: boolean;
  /** Show export functionality (default: true) */
  allowExport?: boolean;
  /** Show import functionality (default: false) */
  allowImport?: boolean;
  /** Show search input (default: true) */
  allowSearch?: boolean;
  /** Show filter controls (default: true) */
  allowFilters?: boolean;
  /** Filter panel starts expanded instead of collapsed (default: false) */
  filtersExpandedByDefault?: boolean;
  /** Show stats display (default: true) */
  allowStats?: boolean;
  /** Enable pagination (default: true) */
  allowPagination?: boolean;
  /** Enable row selection (default: true) */
  allowSelection?: boolean;
}

/**
 * Security permissions enforce authorization based on user roles.
 * These are checked via useAuth().checkPermission() and always take
 * precedence over feature flags.
 */
export interface ListPermissions {
  /** Permission required to create new items */
  create?: Permission;
  /** Permission required to read items */
  read?: Permission;
  /** Permission required to update items */
  update?: Permission;
  /** Permission required to delete items */
  delete?: Permission;
}

/**
 * Filter definition for list filtering UI.
 * Supports multiple filter types with optional dynamic options.
 */
export interface FilterDefinition {
  /** Unique key for the filter */
  key: string;
  /** Display label for the filter */
  label: string;
  /** Type of filter control */
  type: 'select' | 'text' | 'date' | 'multiselect';
  /** Static options or function to generate options from data */
  options?: FilterOption[] | ((items: any[]) => FilterOption[]);
  /** Placeholder text for the filter input */
  placeholder?: string;
  /** CSS class name for styling */
  className?: string;
  /** Maps to store filter key if different from key */
  storeKey?: string;
  /** Render the control locked (e.g. a rep whose only meaningful value is themselves) */
  disabled?: boolean;
}

/**
 * Statistic definition for summary display above the list.
 * Stats can be computed from filtered data or total data.
 */
export interface StatDefinition<T> {
  /** Display label for the stat */
  label: string;
  /** Function to compute the stat value */
  value: (items: T[], store: any) => number | string;
  /** Optional formatter for the computed value */
  format?: (value: number | string) => string;
}

/**
 * Bulk action configuration for operations on multiple selected items.
 * Supports confirmation dialogs and permission checks.
 */
export interface BulkActionConfig<T> {
  /** Unique identifier for the action */
  id: string;
  /** Display label for the action */
  label: string;
  /** Optional icon name */
  icon?: string;
  /** Color theme for the action button */
  color?: 'primary' | 'secondary' | 'success' | 'warning' | 'error';
  /** Whether to show confirmation dialog */
  confirm?: boolean;
  /** Confirmation message (static or dynamic based on items) */
  confirmMessage?: string | ((items: T[]) => string);
  /** Action handler function */
  action: (items: T[], store: any) => Promise<void>;
  /** Permission required to perform this action */
  requirePermission?: Permission;
}

/**
 * Export configuration for CSV generation.
 * Defines how data should be exported to CSV format.
 */
export interface ExportConfig<T> {
  /** Function to generate filename with date */
  filename: (date: string) => string;
  /** CSV column headers */
  headers: string[];
  /** Function to map entity to CSV row */
  mapRow: (item: T) => any[];
  /** Optional info text to include in export */
  includeInfo?: string;
}

/**
 * Validation result for import row validation.
 */
export interface ValidationResult {
  /** Whether the row is valid */
  valid: boolean;
  /** Array of error messages if invalid */
  errors?: string[];
}

/**
 * Result of import operation.
 */
export interface ImportResult {
  /** Whether the import was successful */
  success: boolean;
  /** Number of items successfully imported */
  imported: number;
  /** Number of items that failed to import */
  failed: number;
  /** Array of errors with row numbers */
  errors?: Array<{ row: number; message: string }>;
}

/**
 * Import configuration for CSV upload and processing.
 * Defines validation, mapping, and processing logic.
 */
export interface ImportConfig<T> {
  /** Template filename for users to download */
  templateFilename: string;
  /** Template CSV headers */
  templateHeaders: string[];
  /** Function to validate a CSV row */
  validateRow: (row: any[], rowIndex: number) => ValidationResult;
  /** Function to map CSV row to entity */
  mapRow: (row: any[]) => Partial<T>;
  /** Function to process imported items */
  onImport: (items: Partial<T>[]) => Promise<ImportResult>;
  /** Optional instructions for users */
  instructions?: string;
  /** Maximum file size in bytes (default: 5MB) */
  maxFileSize?: number;
  /** Allowed file extensions (default: ['.csv']) */
  allowedExtensions?: string[];
}

/**
 * Enhanced store interface that all entity stores should follow.
 * Provides standardized methods for list operations.
 */
export interface EnhancedStore<T> {
  /** Array of items */
  items: T[];
  
  /** List state */
  list: {
    loading: boolean;
    error: string | null;
    page: number;
    pageSize: number;
    total: number;
  };
  
  /** Fetch items from API */
  fetchItems: () => Promise<void>;
  /** Set search query */
  setSearch: (query: string) => void;
  /** Set filters */
  setFilters: (filters: Record<string, any>) => void;
  /** Set current page */
  setPage: (page: number) => void;
  /** Set page size */
  setPageSize: (size: number) => void;
  
  /** Optional CRUD operations */
  deleteItem?: (id: string) => Promise<void>;
  bulkUpdateStatus?: (ids: string[], status: string) => Promise<void>;
  
  /** Entity-specific computed values */
  [key: string]: any;
}

/**
 * Auth context provider interface for framework integration.
 * Projects must implement this interface to provide authentication.
 */
export interface AuthContextProvider {
  checkPermission: (permission: string) => boolean;
  user?: any;
}

/**
 * Configuration for the useBaseList hook.
 * Defines all aspects of list behavior and appearance.
 */
export interface BaseListConfig<T, StoreType> {
  /** Entity name (singular) for display messages */
  entityName: string;
  /** Entity name (plural) for display messages */
  entityNamePlural: string;
  
  /** Store hook to use for data management */
  useStore: () => StoreType;
  
  /** Feature flags (independent of permissions) */
  features?: ListFeatures;
  
  /** Security permissions */
  permissions?: ListPermissions;
  
  /** Column definitions for the table */
  columns: ColumnDefinition<T>[];
  
  /** Filter configuration */
  filters?: FilterDefinition[];
  
  /** Stats configuration */
  stats?: StatDefinition<T>[];
  
  /** Bulk actions configuration */
  bulkActions?: BulkActionConfig<T>[];
  
  /** Export configuration */
  export?: ExportConfig<T>;
  
  /** Import configuration */
  import?: ImportConfig<T>;
  
  /** Optional auth context provider (if not provided, uses React Context) */
  authContext?: AuthContextProvider;
  
  /** Callback when edit is triggered */
  onEdit?: (item: T) => void;
  /** Callback when create is triggered */
  onCreate?: () => void;
  /** Callback when item is selected */
  onSelect?: (item: T) => void;
}

/**
 * Return type of the useBaseList hook.
 * Provides state, handlers, and render helpers for list components.
 */
export interface BaseListReturn<T> {
  // State
  /** Current search query */
  searchQuery: string;
  /** Active filters */
  filters: Record<string, any>;
  /** Whether export modal is visible */
  showExportModal: boolean;
  /** Whether import modal is visible */
  showImportModal: boolean;
  
  // Setters
  /** Update search query */
  setSearchQuery: (query: string) => void;
  /** Set a single filter value */
  setFilter: (key: string, value: any) => void;
  /** Clear all filters */
  clearFilters: () => void;
  /** Show/hide export modal */
  setShowExportModal: (show: boolean) => void;
  /** Show/hide import modal */
  setShowImportModal: (show: boolean) => void;
  
  // Computed values (combines features + permissions)
  /** Whether user can create items */
  canCreate: boolean;
  /** Whether user can update items */
  canUpdate: boolean;
  /** Whether user can delete items */
  canDelete: boolean;
  /** Whether user can export data */
  canExport: boolean;
  /** Whether user can import data */
  canImport: boolean;
  /** Whether bulk actions are enabled */
  canBulkAction: boolean;
  
  // Handlers
  /** Handle edit action */
  handleEdit: (item: T) => void;
  /** Handle delete action */
  handleDelete: (item: T) => void;
  /** Handle create action */
  handleCreate: () => void;
  /** Handle export of selected items */
  handleExport: (items: T[]) => void;
  /** Handle export of all items */
  handleExportAll: () => void;
  /** Handle import from file */
  handleImport: (file: File) => Promise<void>;
  
  // Render helpers
  /** Render filter UI */
  renderFilters: () => ReactNode;
  /** Render header action buttons */
  renderHeaderActions: () => ReactNode;
  /** Render statistics display */
  renderStats: () => ReactNode;
  /** Render export modal */
  renderExportModal: () => ReactNode;
  /** Render import modal */
  renderImportModal: () => ReactNode;
  /** Render delete confirmation modal */
  renderDeleteConfirmation: () => ReactNode;
  
  // Data
  /** Processed column definitions */
  columns: ColumnDefinition<T>[];
  /** Processed bulk actions */
  bulkActions: BulkAction<T>[];
  /** Current data items */
  data: T[];
  /** Loading state */
  loading: boolean;
  /** Error message if any */
  error: string | undefined;
  /** Pagination configuration */
  pagination: PaginationConfig;
}

/**
 * Props for list components using the framework.
 */
export interface BaseListComponentProps<T> {
  /** Callback when item is selected */
  onSelect?: (item: T) => void;
  /** Callback when item is edited */
  onEdit?: (item: T) => void;
  /** Callback when create is triggered */
  onCreate?: () => void;
}
