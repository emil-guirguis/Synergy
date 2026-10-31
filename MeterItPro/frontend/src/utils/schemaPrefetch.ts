/**
 * Schema Prefetch Utility
 * 
 * Prefetches commonly used schemas on app startup to improve performance
 */

import { prefetchSchemas } from '@meterit/framework-frontend/components/form/utils/schemaLoader';

/**
 * List of entities to prefetch on app startup
 * Add entities that are frequently accessed
 */
const ENTITIES_TO_PREFETCH = [
  'contact',
  'device',
  'location',
  'meter',
  'meter_reading',
  'user',
  'tenant',
];

/**
 * Prefetch schemas on app startup
 * Call this in your main App component or index file
 * 
 * @returns Promise that resolves when prefetch is complete
 */
export async function prefetchAppSchemas(): Promise<void> {
  try {
    const apiUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

    await prefetchSchemas(ENTITIES_TO_PREFETCH, { baseUrl: apiUrl });
  } catch (error) {
    console.error('[SchemaPrefetch] Failed:', error);
  }
}

/**
 * Prefetch schemas for a specific feature
 * Useful for lazy-loaded routes
 *
 * @param entityNames - Array of entity names to prefetch
 */
export async function prefetchFeatureSchemas(entityNames: string[]): Promise<void> {
  try {
    await prefetchSchemas(entityNames);
  } catch (error) {
    console.error('[Schema Prefetch] Failed to prefetch feature schemas:', error);
  }
}

/**
 * Kick off background downloads for the most-visited lazy route chunks.
 * Calling import() primes the Vite/browser module cache — when React.lazy later
 * resolves the same specifier it gets the cached module with no network round-trip.
 */
export function prefetchAppRoutes(): void {
  // High-priority: users land here first
  import('../pages/DashboardPage').catch(() => null);
  import('../pages/MeterReadingsPage').catch(() => null);
  // Medium-priority: common modules
  import('../features/contacts').catch(() => null);
  import('../pages').catch(() => null); // MetersPage, SettingsPage, ReportsPage barrel
  // Lower-priority: admin modules
  import('../features/users').catch(() => null);
  import('../features/locations').catch(() => null);
  import('../features/devices').catch(() => null);
  import('../features/notifications').catch(() => null);
}
