/**
 * Schema Loader
 * 
 * Fetches entity schemas from the backend API and converts them
 * to frontend-compatible format.
 * 
 * This eliminates the need to duplicate schema definitions between
 * backend and frontend.
 */

import * as React from 'react';
import type { FieldDefinition } from './formSchema';

/**
 * Backend schema format (from API)
 */
export interface BackendFieldDefinition {
  type: string;
  default: any;
  required: boolean;
  readOnly: boolean;
  disable: boolean;
  label: string;
  description: string;
  placeholder: string;
  dbField: string | null;
  enumValues: string[] | null;
  enumLabels: Record<string, string> | null;
  minLength: number | null;
  maxLength: number | null;
  min: number | null;
  max: number | null;
  pattern: string | null;
  showOn?: string[];
  showIf?: { fieldName: string; value: any };
  helpText?: string;
  validate?: boolean;
  validationFields?: string[];
  formGrouping?: {
    tabName: string;
    sectionName: string;
    tabOrder: number;
    sectionOrder: number;
    fieldOrder: number;
  };
}

export interface BackendSchema {
  entityName: string;
  tableName: string;
  description: string;
  formFields: Record<string, BackendFieldDefinition>;
  entityFields: Record<string, BackendFieldDefinition>;
  formTabs?: Array<{
    name: string;
    order?: number | null;
    visibleFor?: ('physical' | 'virtual')[];
    sectionOrientation?: 'horizontal' | 'vertical' | null;
    /** Explicit grid: column count (→ repeat(n, 1fr)) or raw grid-template-columns. */
    columns?: number | string | null;
    /** Raw grid-template-rows; only meaningful with `columns`. */
    rows?: string | null;
    sections: Array<{
      name: string;
      description?: string | null;
      order?: number | null;
      visibleFor?: ('physical' | 'virtual')[];
      fields: Array<{
        name: string;
        order?: number | null;
        visibleFor?: ('physical' | 'virtual')[];
      }>;
      minWidth?: string | null;
      maxWidth?: string | null;
      flex?: number | null;
      flexGrow?: number | null;
      flexShrink?: number | null;
      gridColumn?: string | null;
      gridRow?: string | null;
      /** Section-level read-only: every field in the section renders disabled. */
      readOnly?: boolean | null;
    }>;
  }>;
  formMaxWidth?: string | null;
  defaultSort?: string;
  relationships: Record<string, any>;
  validation: Record<string, any>;
  version: string;
  generatedAt: string;
}

/**
 * Schema cache entry with timestamp for TTL
 */
interface CacheEntry {
  schema: BackendSchema;
  timestamp: number;
}

/**
 * In-memory schema cache to avoid repeated API calls within a session
 */
const schemaCache = new Map<string, CacheEntry>();

/**
 * In-flight fetch promises — deduplicate concurrent fetchSchema calls for the same entity.
 */
const inflightFetches = new Map<string, Promise<BackendSchema>>();

/**
 * Cache TTL in milliseconds (default: 30 minutes)
 */
const CACHE_TTL = 30 * 60 * 1000;

const LS_PREFIX = 'schema_cache_';

/**
 * Minimum backend schema version this frontend understands. Cached schemas
 * with an older version are discarded so backend schema-format changes
 * propagate immediately instead of waiting out the cache TTL.
 */
const MIN_SCHEMA_VERSION = '1.5.0';

function isStaleVersion(schema: BackendSchema): boolean {
  return (schema.version || '0.0.0').localeCompare(MIN_SCHEMA_VERSION, undefined, { numeric: true }) < 0;
}

/** Persist a cache entry to localStorage so it survives F5 */
function persistToStorage(entityName: string, entry: CacheEntry): void {
  try {
    localStorage.setItem(LS_PREFIX + entityName, JSON.stringify(entry));
  } catch {
    // localStorage quota exceeded or unavailable — silently ignore
  }
}

/** Load a cache entry from localStorage into the in-memory map */
function hydrateFromStorage(entityName: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + entityName);
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.timestamp >= CACHE_TTL || isStaleVersion(entry.schema)) {
      localStorage.removeItem(LS_PREFIX + entityName);
      return null;
    }
    schemaCache.set(entityName, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Fetch schema from backend API
 * 
 * @param entityName - Entity name (e.g., 'meter', 'location')
 * @param options - Fetch options
 * @returns Backend schema definition
 */
export async function fetchSchema(
  entityName: string,
  options: { cache?: boolean; baseUrl?: string; ttl?: number } = {}
): Promise<BackendSchema> {
  // Use environment variable for API base URL, fallback to relative path
  const defaultBaseUrl = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL 
    ? (import.meta as any).env.VITE_API_BASE_URL 
    : 'http://localhost:3001/api';
  // Default OFF in dev (`vite dev`) so schema edits (fields, sections, tabs, layout)
  // show up on the next reload instead of being masked by the 30-min cache — this was
  // the cause of "I edited the schema and don't see the change locally" reports.
  // Explicit `cache` in options (e.g. prefetchSchemas) always wins.
  const isDev = typeof import.meta !== 'undefined' && !!(import.meta as any).env?.DEV;
  const { cache = !isDev, baseUrl = defaultBaseUrl, ttl = CACHE_TTL } = options;

  // 1. Check in-memory cache
  if (cache && schemaCache.has(entityName)) {
    const entry = schemaCache.get(entityName)!;
    const age = Date.now() - entry.timestamp;
    if (age < ttl && !isStaleVersion(entry.schema)) {
      return entry.schema;
    }
    schemaCache.delete(entityName);
    localStorage.removeItem(LS_PREFIX + entityName);
  }

  // 2. Check localStorage (survives F5)
  if (cache) {
    const stored = hydrateFromStorage(entityName);
    if (stored) {
      return stored.schema;
    }
  }

  // Deduplicate concurrent fetches for the same entity name
  if (inflightFetches.has(entityName)) {
    return inflightFetches.get(entityName)!;
  }

  const fetchPromise = (async () => {
  try {
    // Get authentication token from localStorage or sessionStorage
    const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');

    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${baseUrl}/schema/${entityName}`, {
      headers,
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch schema: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.message || 'Failed to fetch schema');
    }

    if (!result.data) {
      throw new Error('Schema data is missing from response');
    }

    const schema = result.data as BackendSchema;

    if (cache) {
      const entry: CacheEntry = { schema, timestamp: Date.now() };
      schemaCache.set(entityName, entry);
      persistToStorage(entityName, entry);
    }

    return schema;
  } catch (error) {
    console.error(`Error fetching schema for ${entityName}:`, error);
    throw error;
  }
  })();

  inflightFetches.set(entityName, fetchPromise);
  fetchPromise.finally(() => inflightFetches.delete(entityName));
  return fetchPromise;
}

/**
 * Convert backend field definition to frontend format
 */
function convertFieldDefinition(backendField: BackendFieldDefinition & { validate?: boolean; validationFields?: string[]; formGrouping?: any }): FieldDefinition {
  return {
    type: backendField.type as any,
    default: backendField.default,
    required: backendField.required,
    label: backendField.label,
    apiField: backendField.dbField || undefined,
    dbField: backendField.dbField,
    // Add validation rules (check for null/undefined, not falsy, to allow 0)
    ...(backendField.minLength != null && { minLength: backendField.minLength }),
    ...(backendField.maxLength != null && { maxLength: backendField.maxLength }),
    ...(backendField.min != null && { min: backendField.min }),
    ...(backendField.max != null && { max: backendField.max }),
    ...(backendField.pattern && { pattern: backendField.pattern }),
    ...(backendField.enumValues && { enumValues: backendField.enumValues }),
    ...(backendField.enumLabels && { enumLabels: backendField.enumLabels }),
    // Preserve validation field properties for dropdown rendering
    ...(backendField.validate != null && { validate: backendField.validate }),
    ...(backendField.validationFields && { validationFields: backendField.validationFields }),
    // Preserve readOnly and disable properties for disabling fields
    ...(backendField.readOnly != null && { readOnly: backendField.readOnly }),
    ...(backendField.disable != null && { disable: backendField.disable }),
    // Preserve showOn property for visibility control
    ...(backendField.showOn && { showOn: backendField.showOn }),
    // Preserve showIf for conditional field visibility
    ...(backendField.showIf && { showIf: backendField.showIf }),
    // Preserve helpText for field descriptions
    ...(backendField.helpText && { helpText: backendField.helpText }),
    // Preserve formGrouping for tab/section organization
    ...(backendField.formGrouping && { formGrouping: backendField.formGrouping }),
  };
}

/**
 * Converted schema format for frontend use
 */
export interface ConvertedSchema {
  formFields: Record<string, FieldDefinition>;
  entityFields: Record<string, FieldDefinition>;
  formTabs: Array<{
    name: string;
    order?: number | null;
    visibleFor?: ('physical' | 'virtual')[];
    sectionOrientation?: 'horizontal' | 'vertical' | null;
    /** Explicit grid: column count (→ repeat(n, 1fr)) or raw grid-template-columns. */
    columns?: number | string | null;
    /** Raw grid-template-rows; only meaningful with `columns`. */
    rows?: string | null;
    sections: Array<{
      name: string;
      description?: string | null;
      order?: number | null;
      visibleFor?: ('physical' | 'virtual')[];
      fields: Array<{
        name: string;
        order?: number | null;
        visibleFor?: ('physical' | 'virtual')[];
      }>;
      minWidth?: string | null;
      maxWidth?: string | null;
      flex?: number | null;
      flexGrow?: number | null;
      flexShrink?: number | null;
      gridColumn?: string | null;
      gridRow?: string | null;
      /** Section-level read-only: every field in the section renders disabled. */
      readOnly?: boolean | null;
    }>;
  }> | null;
  entityName: string;
  description: string;
  formMaxWidth?: string | null;
  defaultSort?: string;
  relationships: Record<string, any>;
  /**
   * Primary key field name in backend schema (e.g., 'contact_id')
   * Helps frontend map IDs when API returns non-standard 'id' fields.
   */
  idFieldName?: string | null;
}

/**
 * Convert backend schema to frontend schema format
 */
export function convertSchema(backendSchema: BackendSchema): ConvertedSchema {
  const formFields: Record<string, FieldDefinition> = {};
  const entityFields: Record<string, FieldDefinition> = {};

  // Convert form fields
  Object.entries(backendSchema.formFields).forEach(([fieldName, fieldDef]) => {
    formFields[fieldName] = convertFieldDefinition(fieldDef);
  });

  // Some schemas define fields inside formTabs but not in formFields object.
  // Ensure we include any fields declared inside formTabs into formFields so
  // the frontend (filters, lists, forms) can access them uniformly.
  if (backendSchema.formTabs) {
    backendSchema.formTabs.forEach((tab) => {
      tab.sections?.forEach((section) => {
        section.fields?.forEach((field) => {
          if (field && field.name && !formFields[field.name]) {
            // field may be a lightweight object; convert and merge
            formFields[field.name] = convertFieldDefinition(field as any);
          }
        });
      });
    });
  }

  // Convert entity fields
  Object.entries(backendSchema.entityFields).forEach(([fieldName, fieldDef]) => {
    entityFields[fieldName] = convertFieldDefinition(fieldDef);
  });
  // Determine primary ID field name — prefer explicit declaration from backend schema
  let idFieldName: string | null = (backendSchema as any).idFieldName || null;
  if (!idFieldName) {
    const tableIdField = `${backendSchema.tableName}_id`;
    if (backendSchema.entityFields && backendSchema.entityFields[tableIdField]) {
      idFieldName = tableIdField;
    } else {
      // fallback: first entity field that ends with _id
      const candidate = Object.keys(backendSchema.entityFields || {}).find(k => k.endsWith('_id'));
      idFieldName = candidate || null;
    }
  }

  return {
    formFields,
    entityFields,
    formTabs: backendSchema.formTabs || null,
    entityName: backendSchema.entityName,
    description: backendSchema.description,
    formMaxWidth: backendSchema.formMaxWidth || null,
    defaultSort: backendSchema.defaultSort,
    relationships: backendSchema.relationships,
    idFieldName,
  };
}

/**
 * Load and convert schema from backend
 * 
 * @param entityName - Entity name
 * @returns Converted schema ready for frontend use
 */
export async function loadSchema(entityName: string) {
  const backendSchema = await fetchSchema(entityName);
  return convertSchema(backendSchema);
}

/**
 * Clear schema cache
 */
export function clearSchemaCache(entityName?: string) {
  if (entityName) {
    schemaCache.delete(entityName);
    try { localStorage.removeItem(LS_PREFIX + entityName); } catch {}
  } else {
    schemaCache.clear();
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(LS_PREFIX))
        .forEach(k => localStorage.removeItem(k));
    } catch {}
  }
}

/**
 * Log all schemas currently in memory
 */
export function logSchemasInMemory() {
  if (schemaCache.size === 0) {
    console.log('📋 SCHEMAS IN MEMORY: NONE');
    return;
  }
  
  console.log(`📋 SCHEMAS IN MEMORY: ${schemaCache.size} schemas loaded`);
  schemaCache.forEach((entry, entityName) => {
    const age = Date.now() - entry.timestamp;
    const ageSeconds = Math.round(age / 1000);
    const formFieldCount = Object.keys(entry.schema.formFields).length;
    const entityFieldCount = Object.keys(entry.schema.entityFields).length;
    console.log(`  [${entityName}] ${formFieldCount} form fields, ${entityFieldCount} entity fields (cached ${ageSeconds}s ago)`);
  });
}

/**
 * Prefetch schemas for multiple entities
 * Useful for preloading schemas on app startup
 * 
 * @param entityNames - Array of entity names to prefetch
 * @param options - Fetch options
 * @returns Promise that resolves when all schemas are loaded
 */
export async function prefetchSchemas(
  entityNames: string[],
  options: { baseUrl?: string; ttl?: number } = {}
) {
  const promises = entityNames.map(name => 
    fetchSchema(name, { ...options, cache: true })
  );
  return Promise.all(promises);
}

/**
 * Get cache statistics
 * Useful for debugging and monitoring
 */
export function getCacheStats() {
  const now = Date.now();
  const entries = Array.from(schemaCache.entries());
  
  return {
    size: schemaCache.size,
    entries: entries.map(([entityName, entry]) => ({
      entityName,
      age: now - entry.timestamp,
      expired: now - entry.timestamp >= CACHE_TTL,
    })),
  };
}

/**
 * Invalidate expired cache entries
 * Can be called periodically to clean up stale entries
 */
export function invalidateExpiredCache() {
  const now = Date.now();
  const toDelete: string[] = [];

  schemaCache.forEach((entry, entityName) => {
    if (now - entry.timestamp >= CACHE_TTL) {
      toDelete.push(entityName);
    }
  });

  toDelete.forEach(entityName => {
    schemaCache.delete(entityName);
    localStorage.removeItem(LS_PREFIX + entityName);
  });

  return toDelete.length;
}

/**
 * Get list of available schemas from backend
 */
export async function getAvailableSchemas(baseUrl?: string): Promise<Array<{
  entityName: string;
  tableName: string;
  description: string;
  endpoint: string;
}>> {
  // Use environment variable for API base URL, fallback to relative path
  const defaultBaseUrl = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL 
    ? (import.meta as any).env.VITE_API_BASE_URL 
    : 'http://localhost:3001/api';
  const apiBaseUrl = baseUrl || defaultBaseUrl;
  
  try {
    const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${apiBaseUrl}/schema`, {
      headers,
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch schema list: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.message || 'Failed to fetch schema list');
    }

    return result.data.schemas;
  } catch (error) {
    console.error('Error fetching schema list:', error);
    throw error;
  }
}

/**
 * React hook for loading schemas
 * 
 * @param entityName - Entity name
 * @param options - Options for schema loading
 * @returns Schema state
 */
/**
 * Read schema from cache synchronously, returning null if missing or expired.
 */
function getFromCache(entityName: string): ConvertedSchema | null {
  const entry = schemaCache.get(entityName) ?? hydrateFromStorage(entityName);
  if (!entry) return null;
  if (Date.now() - entry.timestamp >= CACHE_TTL || isStaleVersion(entry.schema)) {
    schemaCache.delete(entityName);
    try { localStorage.removeItem(LS_PREFIX + entityName); } catch {}
    return null;
  }
  return convertSchema(entry.schema);
}

export function useSchema(entityName: string, options?: { bypassCache?: boolean }) {
  // Initialise synchronously from cache so cached schemas render instantly
  const [schema, setSchema] = React.useState<ConvertedSchema | null>(() => {
    if (options?.bypassCache || !entityName) return null;
    return getFromCache(entityName);
  });
  const [loading, setLoading] = React.useState<boolean>(() => {
    if (!entityName) return false;
    if (options?.bypassCache) return true;
    return getFromCache(entityName) === null;
  });
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        if (!options?.bypassCache) {
          const cached = getFromCache(entityName);
          if (cached) {
            if (mounted) { setSchema(cached); setError(null); setLoading(false); }
            return;
          }
        }

        setLoading(true);
        const loadedSchema = await loadSchema(entityName);
        if (mounted) { setSchema(loadedSchema); setError(null); }
      } catch (err) {
        if (mounted) {
          setError(err as Error);
          console.error(`[useSchema] Error loading ${entityName}:`, err);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [entityName]);

  return { schema, loading, error };
}
