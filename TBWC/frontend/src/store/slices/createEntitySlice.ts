// Generic Entity Store Creator

import { create } from 'zustand';
import type { EntityStoreSlice, CacheConfig } from '../types';
import {
  createEntityState,
  createListState,
  isCacheFresh,
  createCacheConfig,
} from '../utils';
import { loadSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import { authService } from '../../services/authService';

// Access tokens expire mid-session and nothing else refreshes them proactively —
// any store action can be the first one to hit a 401. Detect that case, refresh
// once, and retry before giving up and forcing the user back to login.
const AUTH_ERROR_PATTERNS = ['invalid or expired token', 'access token required', 'unauthorized', 'authentication required'];

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return AUTH_ERROR_PATTERNS.some((p) => message.includes(p));
}

function forceLogout(): void {
  authService.setLogoutFlag();
  authService.clearStoredToken();
  if (typeof window !== 'undefined') window.location.href = '/login';
}

async function withAuthRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isAuthError(error)) throw error;

    const newToken = await authService.refresh();
    if (!newToken) {
      forceLogout();
      throw error;
    }

    try {
      return await call();
    } catch (retryError) {
      forceLogout();
      throw retryError;
    }
  }
}

// Generic service interface
export interface EntityService<T> {
  getAll: (params?: any) => Promise<{ items: T[]; total: number; hasMore: boolean }>;
  getById: (id: string) => Promise<T>;
  create: (data: Partial<T>) => Promise<T>;
  update: (id: string, data: Partial<T>) => Promise<T>;
  delete: (id: string) => Promise<void>;
}

// Every store built here registers a resetter, so a session change can wipe all
// of them at once. These stores are module singletons: logging out only clears
// the token + auth context, it does not reload the page, so without this the
// next user to sign in inherits the previous user's rows, filters and lastFetch
// (a rep landing on Orders would be served the admin's cached, unscoped list
// straight from `items` because the 5-minute cache was still fresh).
const entityStoreResetters: Array<() => void> = [];

/** Clear every entity store's data + list state. Call on login and on logout. */
export function resetAllEntityStores(): void {
  for (const reset of entityStoreResetters) reset();
}

// Create entity store
export const createEntityStore = <T extends { id: string }>(
  service: EntityService<T>,
  options: {
    name: string;
    cache?: Partial<CacheConfig>;
  }
) => {
  const cacheConfig = createCacheConfig(options.cache);

  // In-flight request deduplication: multiple concurrent callers get the same
  // promise instead of each firing a separate API request.
  let fetchingPromise: Promise<void> | null = null;
  // Bypass-cache calls (filter/search changes, pagination) skip dedup above and
  // each fire their own request. Network responses can then land out of order —
  // e.g. an old unfiltered fetch resolving after a newer filtered one — and the
  // last one to land would silently overwrite state with stale data. Guard with
  // a generation counter: only the response from the most recently issued fetch
  // is applied; earlier ones are discarded on arrival.
  let latestRequestId = 0;

  const useStore = create<EntityStoreSlice<T>>()(
    (set, get) => ({
      // Initial state
      ...createEntityState<T>(),
      list: createListState(),

      // Entity actions
      setItems: (items) => set({ items: items as any }),
      addItem: (item) => set((state) => ({ items: [item as any, ...state.items], total: state.total + 1 })),

      updateItem: (id, updates) => {
        set((state) => ({
          items: state.items.map(item => item.id === id ? { ...item, ...updates } as any : item),
          selectedItem: state.selectedItem?.id === id ? { ...state.selectedItem, ...updates } as any : state.selectedItem,
        }));
      },

      removeItem: (id) => {
        set((state) => ({
          items: state.items.filter(item => item.id !== id) as any,
          total: Math.max(0, state.total - 1),
          selectedItem: state.selectedItem?.id === id ? null : state.selectedItem,
        }));
      },

      // Optimistic update methods for form integration
      addItemToList: (item) => set((state) => ({ items: [item as any, ...state.items], total: state.total + 1 })),

      updateItemInList: (item) => {
        set((state) => {
          const index = state.items.findIndex(i => String(i.id) === String(item.id));
          if (index !== -1) {
            const items = [...state.items];
            items[index] = item as any;
            return {
              items: items as any,
              selectedItem: state.selectedItem && String(state.selectedItem.id) === String(item.id) ? item as any : state.selectedItem,
            };
          }
          console.warn('[updateItemInList] Item not found in list, adding as new item');
          return {
            items: [item as any, ...state.items] as any,
            total: state.total + 1,
            selectedItem: state.selectedItem && String(state.selectedItem.id) === String(item.id) ? item as any : state.selectedItem,
          };
        });
      },

      setSelectedItem: (item) => set({ selectedItem: item as any }),
      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),
      setTotal: (total) => set({ total }),
      setHasMore: (hasMore) => set({ hasMore }),
      setLastFetch: (timestamp) => set({ lastFetch: timestamp }),

      reset: () => {
        // Invalidate anything already in flight: a request issued by the previous
        // session can still be on the wire, and its response would repopulate the
        // store we just cleared (the requestId check below discards it instead).
        latestRequestId++;
        fetchingPromise = null;
        set({ ...createEntityState<T>() as any, list: createListState() });
      },

      // List actions
      setPage: (page) => set((state) => ({ list: { ...state.list, page } })),
      setPageSize: (pageSize) => set((state) => ({ list: { ...state.list, pageSize, page: 1 } })),
      setSearch: (search) => set((state) => ({ list: { ...state.list, search, page: 1 } })),
      setFilters: (filters) => set((state) => ({ list: { ...state.list, filters, page: 1 } })),
      setSorting: (sortBy, sortOrder) => set((state) => ({ list: { ...state.list, sortBy, sortOrder } })),
      resetFilters: () => set((state) => ({ list: { ...state.list, search: '', filters: {}, page: 1 } })),
      setListLoading: (loading) => set((state) => ({ list: { ...state.list, loading } })),
      setListError: (error) => set((state) => ({ list: { ...state.list, error } })),
      resetList: () => set({ list: createListState() }),

      // API actions
      fetchItems: async (params) => {
        const state = get();

        console.log('[fetchItems] Called with params:', params);
        console.log('[fetchItems] Current state.list:', state.list);

        const hasRealParams = params && Object.keys(params).some(key => key !== '_bypassCache');
        const shouldBypassCache = params && (hasRealParams || params._bypassCache);

        if (state.lastFetch && isCacheFresh(state.lastFetch, cacheConfig.ttl) && !shouldBypassCache) {
          console.log('[fetchItems] Using cached data - cache is fresh');
          return;
        }

        // If a fetch is already in flight, return the same promise so concurrent
        // callers don't each fire a separate API request.
        if (fetchingPromise && !shouldBypassCache) {
          console.log('[fetchItems] Deduplicating in-flight request');
          return fetchingPromise;
        }

        set((s) => ({ list: { ...s.list, loading: true, error: null } }));

        const requestId = ++latestRequestId;

        const doFetch = async () => {
          try {
            let queryParams = hasRealParams ? params : {
              page: state.list.page,
              pageSize: state.list.pageSize,
              // Also send `limit` — some services read `limit` rather than `pageSize`.
              // Sending both keeps every service's page-size honored server-side.
              limit: state.list.pageSize,
              search: state.list.search,
              filters: state.list.filters,
              sortBy: state.list.sortBy,
              sortOrder: state.list.sortOrder,
            };

            // Load schema once (hits in-memory cache, near-instant) and use it for
            // both defaultSort and id normalisation — avoids two separate awaits.
            let schema = null;
            try {
              schema = await loadSchema(options.name);
            } catch (e) {
              console.warn('[fetchItems] Could not load schema:', e);
            }

            if (!queryParams.sortBy) {
              if (schema?.defaultSortBy) {
                // schema.defaultSortBy is "field" or "field asc"/"field desc" —
                // split so the arrow indicator (list.sortBy/sortOrder below) and
                // the actual query param agree on direction.
                const [field, dir] = schema.defaultSortBy.trim().split(/\s+/);
                queryParams.sortBy = field;
                queryParams.sortOrder = dir;
                console.log('[fetchItems] Using default sortBy from schema:', field, dir);
              } else {
                queryParams.sortOrder = undefined;
              }
            }

            console.log('[fetchItems] Calling service.getAll with queryParams:', queryParams);
            const response = await withAuthRetry(() => service.getAll(queryParams));
            console.log('[fetchItems] Got response:', response);

            // Normalise entity IDs using the schema's idFieldName
            const idField = schema?.idFieldName;
            if (idField && Array.isArray(response.items)) {
              response.items = response.items.map((it: any) => {
                if ((it.id === undefined || it.id === null) && (it as any)[idField] !== undefined) {
                  return { ...it, id: (it as any)[idField] };
                }
                return it;
              });
            }

            if (requestId !== latestRequestId) {
              console.log('[fetchItems] Discarding stale response for requestId', requestId);
              return;
            }

            set((s) => ({
              items: response.items as any,
              total: response.total,
              hasMore: response.hasMore,
              lastFetch: Date.now(),
              list: {
                ...s.list,
                loading: false,
                error: null,
                total: response.total,
                // Record the sort actually applied to this response (explicit
                // param or schema default) so the list UI can render the arrow.
                sortBy: queryParams.sortBy ?? s.list.sortBy,
                sortOrder: queryParams.sortOrder ?? s.list.sortOrder,
              },
            }));
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Failed to fetch items';
            const errorDetail = (error as any)?.detail || (error as any)?.data?.detail || '';
            const fullMessage = errorDetail ? `${errorMessage}: ${errorDetail}` : errorMessage;

            console.error('[fetchItems] Error:', { message: errorMessage, detail: errorDetail, fullError: error });

            if (requestId !== latestRequestId) {
              return;
            }

            set((s) => ({ list: { ...s.list, loading: false, error: fullMessage }, error: fullMessage }));
            throw error;
          } finally {
            fetchingPromise = null;
          }
        };

        fetchingPromise = doFetch();
        return fetchingPromise;
      },

      fetchItem: async (id) => {
        set({ loading: true, error: null });

        try {
          const item = await withAuthRetry(() => service.getById(id));

          set((state) => ({
            selectedItem: item as any,
            loading: false,
            error: null,
            items: state.items.map(i => i.id === id ? item as any : i),
          }));

          try {
            const schema = await loadSchema(options.name);
            const idField = schema?.idFieldName;
            if (idField && item && (item.id === undefined || item.id === null) && (item as any)[idField] !== undefined) {
              (item as any).id = (item as any)[idField];
            }
          } catch (e) {
            console.warn('[fetchItem] Could not normalize id:', e);
          }

          return item;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch item';
          const errorDetail = (error as any)?.detail || (error as any)?.data?.detail || '';
          const fullMessage = errorDetail ? `${errorMessage}: ${errorDetail}` : errorMessage;

          console.error('[fetchItemById] Error:', { message: errorMessage, detail: errorDetail, fullError: error });

          set({ loading: false, error: fullMessage });
          throw error;
        }
      },

      createItem: async (data) => {
        set({ loading: true, error: null });

        try {
          const newItem = await withAuthRetry(() => service.create(data));

          set((state) => ({
            items: [newItem as any, ...state.items],
            total: state.total + 1,
            selectedItem: newItem as any,
            loading: false,
            error: null,
          }));

          try {
            const schema = await loadSchema(options.name);
            const idField = schema?.idFieldName;
            if (idField && newItem && (newItem.id === undefined || newItem.id === null) && (newItem as any)[idField] !== undefined) {
              (newItem as any).id = (newItem as any)[idField];
            }
          } catch (e) {
            console.warn('[createItem] Could not normalize id:', e);
          }

          return newItem;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to create item';
          const errorDetail = (error as any)?.detail || (error as any)?.data?.detail || '';
          const fullMessage = errorDetail ? `${errorMessage}: ${errorDetail}` : errorMessage;

          console.error('[createItem] Error:', { message: errorMessage, detail: errorDetail, fullError: error });

          set({ loading: false, error: fullMessage });
          throw error;
        }
      },

      updateItemById: async (id, data) => {
        const state = get();
        const originalItem = state.items.find(item => item.id === id);

        if (originalItem) {
          set((s) => ({
            items: s.items.map(item => item.id === id ? { ...originalItem, ...data } as any : item),
            selectedItem: s.selectedItem?.id === id ? { ...s.selectedItem, ...data } as any : s.selectedItem,
          }));
        }

        try {
          const updatedItem = await withAuthRetry(() => service.update(id, data));

          set((s) => ({
            items: s.items.map(item => item.id === id ? updatedItem as any : item),
            selectedItem: s.selectedItem?.id === id ? updatedItem as any : s.selectedItem,
            error: null,
          }));

          try {
            const schema = await loadSchema(options.name);
            const idField = schema?.idFieldName;
            if (idField && updatedItem && (updatedItem.id === undefined || updatedItem.id === null) && (updatedItem as any)[idField] !== undefined) {
              (updatedItem as any).id = (updatedItem as any)[idField];
            }
          } catch (e) {
            console.warn('[updateItemById] Could not normalize id:', e);
          }

          return updatedItem;
        } catch (error) {
          if (originalItem) {
            set((s) => ({
              items: s.items.map(item => item.id === id ? originalItem as any : item),
              selectedItem: s.selectedItem?.id === id ? originalItem as any : s.selectedItem,
            }));
          }

          const errorMessage = error instanceof Error ? error.message : 'Failed to update item';
          const errorDetail = (error as any)?.detail || (error as any)?.data?.detail || '';
          const fullMessage = errorDetail ? `${errorMessage}: ${errorDetail}` : errorMessage;

          console.error('[updateItemById] Error:', { message: errorMessage, detail: errorDetail, fullError: error });

          set({ error: fullMessage });
          throw error;
        }
      },

      deleteItem: async (id) => {
        const state = get();
        const originalItems = state.items;
        const originalTotal = state.total;
        const originalSelected = state.selectedItem;

        set((s) => ({
          items: s.items.filter(item => item.id !== id) as any,
          total: Math.max(0, s.total - 1),
          selectedItem: s.selectedItem?.id === id ? null : s.selectedItem,
        }));

        try {
          await withAuthRetry(() => service.delete(id));
          set({ error: null });
        } catch (error) {
          set({ items: originalItems, total: originalTotal, selectedItem: originalSelected as any });

          const errorMessage = error instanceof Error ? error.message : 'Failed to delete item';
          set({ error: errorMessage });
          throw error;
        }
      },
    })
  );

  entityStoreResetters.push(() => useStore.getState().reset());

  return useStore;
};

// Helper to create entity hook
export const createEntityHook = <T extends { id: string }>(
  store: ReturnType<typeof createEntityStore<T>>
) => {
  return () => {
    const storeState = store();
    
    return {
      // State
      items: storeState.items,
      selectedItem: storeState.selectedItem,
      loading: storeState.loading,
      error: storeState.error,
      total: storeState.total,
      hasMore: storeState.hasMore,
      list: storeState.list,
      
      // Actions
      fetchItems: storeState.fetchItems,
      fetchItem: storeState.fetchItem,
      createItem: storeState.createItem,
      updateItem: storeState.updateItemById,
      deleteItem: storeState.deleteItem,
      setSelectedItem: storeState.setSelectedItem,
      reset: storeState.reset,
      
      // Optimistic update methods
      addItemToList: storeState.addItemToList,
      updateItemInList: storeState.updateItemInList,
      
      // List actions
      setPage: storeState.setPage,
      setPageSize: storeState.setPageSize,
      setSearch: storeState.setSearch,
      setFilters: storeState.setFilters,
      setSorting: storeState.setSorting,
      resetFilters: storeState.resetFilters,
    };
  };
};