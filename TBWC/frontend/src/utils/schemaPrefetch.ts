/**
 * Schema Prefetch Utility
 *
 * Prefetches commonly used schemas on app startup to improve performance.
 * Mirrors MeterItPro/frontend/src/utils/schemaPrefetch.ts.
 */

import { prefetchSchemas } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import { API_BASE_URL } from '../config/api';

/**
 * List of entities to prefetch on app startup.
 * One per schemaName used across the portal's forms/lists.
 */
const ENTITIES_TO_PREFETCH = [
  'order',
  'quote',
  'inventory',
  'invoice',
  'payment',
  'user',
  'customer',
  'support_ticket',
];

/**
 * Prefetch schemas on app startup.
 * Call this once auth has resolved in App.tsx.
 */
export async function prefetchAppSchemas(): Promise<void> {
  try {
    await prefetchSchemas(ENTITIES_TO_PREFETCH, { baseUrl: API_BASE_URL });
  } catch (error) {
    console.error('[SchemaPrefetch] Failed:', error);
  }
}

/**
 * Prefetch schemas for a specific feature.
 * Useful for lazy-loaded routes.
 */
export async function prefetchFeatureSchemas(entityNames: string[]): Promise<void> {
  try {
    await prefetchSchemas(entityNames, { baseUrl: API_BASE_URL });
  } catch (error) {
    console.error('[SchemaPrefetch] Failed to prefetch feature schemas:', error);
  }
}
