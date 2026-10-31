// Main Store Index

// Export types
export type * from './types';

// Export utilities
export * from './utils';

// Export store slices
export * from './slices/uiSlice';

// Export simple store for basic functionality
export * from './simple/simpleStore';

// Export patterns (basic ones that work)
export * from './patterns/loadingErrorPatterns';

// Export cache and sync
export { CacheManager, globalCache, cacheInvalidation } from './cache/cacheManager';
export { SyncManager, globalSyncManager, useSyncStats, withOfflineSupport } from './sync/syncManager';

// Export middleware
export { withApiCall, withTokenRefresh } from './middleware/apiMiddleware';

// Re-export commonly used hooks
export { useAuth } from '../hooks/useAuth'; // Use Context-based auth
export { useUI } from './slices/uiSlice';

// Store initialization and middleware
import { useUIStore } from './slices/uiSlice';

import { globalCache } from './cache/cacheManager';
import { globalSyncManager } from './sync/syncManager';

// Initialize responsive listener
let responsiveInitialized = false;

export const initializeStore = () => {
  if (responsiveInitialized) return;
  
  // Set up responsive listener
  const updateScreenSize = () => {
    const isMobile = window.innerWidth < 768;
    const isTablet = window.innerWidth >= 768 && window.innerWidth < 1024;
    const isDesktop = window.innerWidth >= 1024;
    useUIStore.getState().setScreenSize(isMobile, isTablet, isDesktop);
  };

  // Initial screen size
  updateScreenSize();

  // Listen for resize events
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', updateScreenSize);
    responsiveInitialized = true;
  }
};

// Auto-initialize store
if (typeof window !== 'undefined') {
  initializeStore();
  
  // Initialize cache and sync on app start
}

// Store devtools (development only)
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  // Add zustand devtools if available in development
}

// Global error handler for store actions
export const handleStoreError = (error: unknown, context: string) => {
  console.error(`Store error in ${context}:`, error);
  
  const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
  
  // Add error notification
  useUIStore.getState().addNotification({
    type: 'error',
    title: 'Error',
    message: errorMessage,
    duration: 0, // Don't auto-dismiss errors
  });
  
  return errorMessage;
};

// Store persistence utilities
export const clearAllStores = () => {
  // Note: Auth is now handled by AuthContext, not Zustand
  // Clear auth via authService if needed
  
  // Reset UI store
  useUIStore.setState({
    ...useUIStore.getState(),
    notifications: [],
    modals: {},
    loading: {},
    mobileNavOpen: false,
  });
  
  // Clear cache and sync
  globalCache.clear();
  globalSyncManager.clearAll();
};

// Store hydration for SSR (if needed)
export const hydrateStores = (initialState?: any) => {
  if (!initialState) return;
  
  // Note: Auth hydration is handled by AuthContext
  
  // Hydrate UI store
  if (initialState.ui) {
    useUIStore.setState(initialState.ui);
  }
};

// Export store instances for direct access (use sparingly)
export { useUIStore };