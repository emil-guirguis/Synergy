import React, { createContext, useContext, useReducer, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { AuthContextType, AuthState, AuthResponse, LoginCredentials, User, UserRole } from '../types/auth';
import { ROLE_PERMISSIONS } from '../types/auth';
import { authService } from '../services/authService';
import { setSystemConfig } from '@meterit/framework-frontend/utils';

// Initial state
const initialState: AuthState = {
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  locations: [],
};

// Auth actions
type AuthAction =
  | { type: 'LOGIN_START' }
  | { type: 'LOGIN_SUCCESS'; payload: { user: User; locations: any[] } }
  | { type: 'LOGIN_FAILURE'; payload: string }
  | { type: 'LOGOUT' }
  | { type: 'REFRESH_TOKEN_SUCCESS'; payload: { user: User; locations: any[] } }
  | { type: 'REFRESH_TOKEN_FAILURE' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_LOCATIONS'; payload: any[] };

// Auth reducer
const authReducer = (state: AuthState, action: AuthAction): AuthState => {
  switch (action.type) {
    case 'LOGIN_START':
      return {
        ...state,
        isLoading: true,
        error: null,
      };
    case 'LOGIN_SUCCESS':
      return {
        ...state,
        user: action.payload.user,
        locations: action.payload.locations,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      };
    case 'LOGIN_FAILURE':
      return {
        ...state,
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: action.payload,
        locations: [],
      };
    case 'LOGOUT':
      return {
        ...state,
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        locations: [],
      };
    case 'REFRESH_TOKEN_SUCCESS':
      return {
        ...state,
        user: action.payload.user,
        locations: action.payload.locations,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      };
    case 'REFRESH_TOKEN_FAILURE':
      return {
        ...state,
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        locations: [],
      };
    case 'SET_LOADING':
      return {
        ...state,
        isLoading: action.payload,
      };
    case 'CLEAR_ERROR':
      return {
        ...state,
        error: null,
      };
    case 'SET_LOCATIONS':
      return {
        ...state,
        locations: action.payload,
      };
    default:
      return state;
  }
};

// Create context
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Auth provider props
interface AuthProviderProps {
  children: ReactNode;
}

// Auth provider component
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [state, dispatch] = useReducer(authReducer, initialState);

  // Listen for forced logout signals from the auth interceptor
  useEffect(() => {
    const handleForceLogout = () => {
      dispatch({ type: 'LOGOUT' });
    };
    window.addEventListener('auth:force-logout', handleForceLogout);
    return () => window.removeEventListener('auth:force-logout', handleForceLogout);
  }, []);

  // Mirror the authenticated user's resolved display preferences (tenant
  // default, overridden per-user — see getCachedUser()'s COALESCE) onto the
  // framework's System Config store, so formatDate/formatCurrency/etc. pick
  // them up anywhere in the app without drilling the user object through
  // every call site. Runs on the sparse JWT-decoded "fast path" user too
  // (fields undefined there) — harmless, formatters fall back to defaults
  // until the background /auth/verify resolves and this re-fires.
  useEffect(() => {
    const u: any = state.user;
    setSystemConfig({
      timezone: u?.timezone ?? null,
      date_format: u?.date_format ?? null,
      time_format: u?.time_format ?? null,
      currency: u?.currency ?? null,
      default_page_size: u?.default_page_size ?? null,
    });
  }, [state.user]);

  // Initialize authentication state on app load
  useEffect(() => {
    const initializeAuth = async () => {
      const t0 = performance.now();
      const log = (msg: string) => {
        const ms = (performance.now() - t0).toFixed(0);
        console.log(`[AUTH +${ms}ms] ${msg}`);
      };

      log('Starting auth initialization');

      const normalizePermissions = (perms: any): string[] => {
        if (!perms) return [];
        if (Array.isArray(perms)) return perms;
        if (typeof perms === 'object') {
          const result: string[] = [];
          Object.entries(perms).forEach(([moduleName, actions]) => {
            if (typeof actions === 'object' && actions !== null) {
              Object.entries(actions).forEach(([actionName, allowed]) => {
                if (allowed) result.push(`${moduleName}:${actionName}`);
              });
            }
          });
          return result;
        }
        return [];
      };

      try {
        dispatch({ type: 'SET_LOADING', payload: true });

        // Check logout flag FIRST - if set, prevent any auto-login
        if (authService.hasLogoutFlag()) {
          log('User explicitly logged out, skipping auto-login');
          authService.clearStoredToken();
          dispatch({ type: 'SET_LOADING', payload: false });
          return;
        }

        const token = authService.getStoredToken();
        log(`Token in storage: ${token ? 'YES' : 'NO'}`);

        if (!token) {
          log('No token — user not authenticated');
          dispatch({ type: 'SET_LOADING', payload: false });
          return;
        }

        // --- FAST PATH: decode user from JWT without a network call ---
        const isTokenValid = authService.isAuthenticated();
        log(`Token locally valid (not expired): ${isTokenValid}`);

        if (isTokenValid) {
          const cachedUser = authService.getCurrentUserFromToken();
          log(`User decoded from token: ${cachedUser ? cachedUser.email ?? 'ok' : 'null'}`);

          if (cachedUser) {
            const normalizedUser = {
              ...cachedUser,
              permissions: normalizePermissions((cachedUser as any).permissions),
            };
            dispatch({ type: 'LOGIN_SUCCESS', payload: { user: normalizedUser, locations: [] } });
            log(`UI unblocked from cached token — background verify starting`);

            // Verify in background; only update state if the server returns meaningfully different info
            authService.verifyToken().then(freshUser => {
              const elapsed = (performance.now() - t0).toFixed(0);
              if (freshUser) {
                const normalizedFresh = {
                  ...freshUser,
                  permissions: normalizePermissions((freshUser as any).permissions),
                };
                // Skip dispatch if identity hasn't changed — avoids a re-render cascade
                const identityChanged =
                  normalizedFresh.users_id !== cachedUser.users_id ||
                  normalizedFresh.email !== cachedUser.email ||
                  normalizedFresh.client !== (cachedUser as any).client ||
                  normalizedFresh.role !== cachedUser.role;
                if (identityChanged) {
                  log(`Background verify succeeded (+${elapsed}ms) — identity changed, updating state`);
                  dispatch({ type: 'REFRESH_TOKEN_SUCCESS', payload: { user: normalizedFresh, locations: [] } });
                } else {
                  log(`Background verify succeeded (+${elapsed}ms) — identity unchanged, skipping re-render`);
                }
              } else {
                log(`Background verify returned null (+${elapsed}ms) — token may be revoked, logging out`);
                authService.clearStoredToken();
                dispatch({ type: 'LOGOUT' });
              }
            }).catch(err => {
              log(`Background verify error (+${(performance.now() - t0).toFixed(0)}ms): ${err?.message}`);
              // Don't log out on network error — user may be offline
            });

            return;
          }
        }

        // --- SLOW PATH: token expired or couldn't decode — must verify with backend ---
        log('Token expired or undecodable — verifying with backend...');
        try {
          const user = await authService.verifyToken();
          log(`Backend verify completed (+${(performance.now() - t0).toFixed(0)}ms): ${user ? user.email ?? 'ok' : 'null'}`);
          if (user) {
            const normalizedUser = { ...user, permissions: normalizePermissions((user as any).permissions) };
            dispatch({ type: 'LOGIN_SUCCESS', payload: { user: normalizedUser, locations: [] } });
          } else {
            authService.clearStoredToken();
            dispatch({ type: 'SET_LOADING', payload: false });
          }
        } catch (verifyError) {
          log(`Backend verify error: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
          authService.clearStoredToken();
          dispatch({ type: 'SET_LOADING', payload: false });
        }
      } catch (error) {
        console.error('[AUTH] initializeAuth unexpected error:', error);
        authService.clearStoredToken();
        dispatch({ type: 'SET_LOADING', payload: false });
      }
    };

    initializeAuth();
  }, []);

  // Set up automatic token refresh
  useEffect(() => {
    let refreshInterval: NodeJS.Timeout | undefined;

    if (state.isAuthenticated) {
      // Refresh token every 14 minutes (assuming 15-minute token expiry)
      refreshInterval = setInterval(async () => {
        try {
          await refreshToken();
        } catch (error: unknown) {
          console.error('Automatic token refresh failed:', error);
          // If refresh fails, logout user
          logout();
        }
      }, 14 * 60 * 1000); // 14 minutes
    }

    return () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    };
  }, [state.isAuthenticated]);

  // Login function
  const login = async (credentials: LoginCredentials): Promise<AuthResponse> => {
    try {
      console.log('🚀 Starting login process in AuthContext...');
      dispatch({ type: 'LOGIN_START' });

      const authResponse = await authService.login(credentials);
      console.log('📦 Auth response received in AuthContext');

      // If 2FA is required, don't dispatch LOGIN_SUCCESS yet - return early
      if (authResponse.requires_2fa) {
        dispatch({ type: 'SET_LOADING', payload: false });
        return authResponse;
      }

      // Ensure locations are included in the response
      const locations = authResponse.locations || [];

      // Normalize permissions if necessary
      const normalizePermissions = (perms: any) => {
        if (!perms) return [];
        if (Array.isArray(perms)) return perms;
        if (typeof perms === 'object') {
          const result: string[] = [];
          Object.entries(perms).forEach(([moduleName, actions]) => {
            if (typeof actions === 'object' && actions !== null) {
              Object.entries(actions).forEach(([actionName, allowed]) => {
                if (allowed) {
                  result.push(`${moduleName}:${actionName}`);
                }
              });
            }
          });
          return result;
        }
        return [];
      };

      const normalizedUser = {
        ...authResponse.user,
        permissions: normalizePermissions(authResponse.user.permissions),
      };

      dispatch({
        type: 'LOGIN_SUCCESS',
        payload: {
          user: normalizedUser,
          locations: locations
        }
      });

      // Clear logout flag since user successfully logged in
      authService.clearLogoutFlag();
      console.log('✅ Login completed successfully in AuthContext');
      return authResponse;
    } catch (error) {
      console.error('❌ Login failed in context:', error);
      const errorMessage = error instanceof Error ? error.message : 'Login failed';
      dispatch({ type: 'LOGIN_FAILURE', payload: errorMessage });
      throw error;
    }
  };

  // Logout function
  const logout = (): void => {
    try {
      console.log('🚪 Logging out user...');

      // Capture token BEFORE clearing so the API call can still authenticate
      const currentToken = authService.getStoredToken();

      authService.clearStoredToken();
      console.log('🗑️ Tokens cleared');

      // Set logout flag to prevent auto-login
      authService.setLogoutFlag();
      console.log('🚩 Logout flag set');

      // Dispatch logout to clear state
      dispatch({ type: 'LOGOUT' });
      console.log('✅ Logout state updated');

      // Call logout API with captured token (token already cleared from storage)
      authService.logout(currentToken).catch((error: unknown) => {
        console.error('Logout API call failed:', error);
      });
    } catch (error) {
      console.error('Logout error:', error);
      // Still dispatch logout to clear local state
      dispatch({ type: 'LOGOUT' });
    }
  };

  // Refresh token function
  const refreshToken = async (): Promise<void> => {
    try {
      const refreshTokenValue = authService.getStoredRefreshToken();
      if (!refreshTokenValue) {
        throw new Error('No refresh token available');
      }

      const authResponse = await authService.refreshToken(refreshTokenValue);
      
      // Update stored tokens
      authService.storeTokens(authResponse.token, authResponse.refreshToken, authResponse.expiresIn);
      
      // Normalize permissions for refreshed user
      const normalizePermissions = (perms: any) => {
        if (!perms) return [];
        if (Array.isArray(perms)) return perms;
        if (typeof perms === 'object') {
          const result: string[] = [];
          Object.entries(perms).forEach(([moduleName, actions]) => {
            if (typeof actions === 'object' && actions !== null) {
              Object.entries(actions).forEach(([actionName, allowed]) => {
                if (allowed) {
                  result.push(`${moduleName}:${actionName}`);
                }
              });
            }
          });
          return result;
        }
        return [];
      };

      const normalizedUser = {
        ...authResponse.user,
        permissions: normalizePermissions(authResponse.user.permissions),
      };

      dispatch({ 
        type: 'REFRESH_TOKEN_SUCCESS', 
        payload: {
          user: normalizedUser,
          locations: authResponse.locations || []
        }
      });
    } catch (error) {
      console.error('Token refresh failed:', error);
      dispatch({ type: 'REFRESH_TOKEN_FAILURE' });
      throw error;
    }
  };

  // Self-service display preference override (Settings > System Config's
  // per-user override). Reuses REFRESH_TOKEN_SUCCESS — same "replace the
  // cached user, keep locations" shape.
  const updatePreferences = async (
    updates: Partial<Pick<User, 'timezone' | 'date_format' | 'time_format' | 'default_page_size'>>
  ): Promise<void> => {
    const updated = await authService.updatePreferences(updates);

    const normalizePermissions = (perms: any) => {
      if (!perms) return [];
      if (Array.isArray(perms)) return perms;
      if (typeof perms === 'object') {
        const result: string[] = [];
        Object.entries(perms).forEach(([moduleName, actions]) => {
          if (typeof actions === 'object' && actions !== null) {
            Object.entries(actions).forEach(([actionName, allowed]) => {
              if (allowed) result.push(`${moduleName}:${actionName}`);
            });
          }
        });
        return result;
      }
      return [];
    };

    dispatch({
      type: 'REFRESH_TOKEN_SUCCESS',
      payload: {
        user: { ...updated, permissions: normalizePermissions(updated.permissions) },
        locations: state.locations,
      },
    });
  };

  // Check if user has specific permission
  const checkPermission = (permission?: string): boolean => {
    if (!permission) return true;
    if (!state.user) {
      console.warn('[AUTH] checkPermission: No user in state');
      return false;
    }
    
    // Handle permissions as array (normal case)
    if (Array.isArray(state.user.permissions)) {
      if (state.user.permissions.length === 0) {
        console.warn('[AUTH] checkPermission: User has no permissions', {
          permission,
          userRole: state.user.role,
          permissionsArray: state.user.permissions
        });
        return false;
      }
      
      const hasPermission = state.user.permissions.includes(permission);
      if (hasPermission) return true;

      // Fallback: if user's role grants the permission, allow it (backend may omit explicit perms)
      try {
        const rolePerms = ROLE_PERMISSIONS[(state.user as any).role as UserRole];
        if (rolePerms && Array.isArray(rolePerms) && rolePerms.includes(permission as any)) {
          console.log('[AUTH] checkPermission: Permission granted via role mapping', { permission, userRole: state.user.role });
          return true;
        }
      } catch (e) {
        // ignore and continue to other fallbacks
      }

      // Try common normalization alternatives (singular/plural mismatches)
      const [module, action] = (permission || '').split(':');
      if (module && action) {
        const altCandidates: string[] = [];
        // pluralize
        if (!module.endsWith('s')) altCandidates.push(`${module}s:${action}`);
        // singularize
        if (module.endsWith('s')) altCandidates.push(`${module.replace(/s$/, '')}:${action}`);
        // namespace fallback: try prefixing with 'core' or 'app' (some backends use namespacing)
        altCandidates.push(`${module}:*`);

        for (const alt of altCandidates) {
          if (state.user.permissions.includes(alt)) {
            console.log('[AUTH] checkPermission: Permission granted via alternative match', { permission, alt, userRole: state.user.role });
            return true;
          }
        }
      }

      console.warn('[AUTH] checkPermission: Permission denied', {
        permission,
        userPermissions: state.user.permissions,
        userRole: state.user.role
      });
      return false;
    }
    
    // Handle permissions as nested object: { module: { action: boolean } }
    if (typeof state.user.permissions === 'object' && state.user.permissions !== null) {
      console.log('[AUTH] checkPermission: Permissions is nested object, checking format', {
        permission,
        permissionsKeys: Object.keys(state.user.permissions)
      });
      
      // Parse permission string: "module:action"
      const [module, action] = permission.split(':');
      
      if (!module || !action) {
        console.warn('[AUTH] checkPermission: Invalid permission format (expected "module:action")', {
          permission
        });
        return false;
      }
      
      // Check if module exists and action is true
      const permissionsObj = state.user.permissions as Record<string, Record<string, boolean>>;
      let hasPermission = permissionsObj[module]?.[action] === true;
      // Try pluralization fallback if module key not found
      if (!hasPermission) {
        const pluralKey = module.endsWith('s') ? module : `${module}s`;
        const singularKey = module.endsWith('s') ? module.replace(/s$/, '') : module;
        if (permissionsObj[pluralKey]?.[action] === true) hasPermission = true;
        if (!hasPermission && permissionsObj[singularKey]?.[action] === true) hasPermission = true;
      }
      
      if (!hasPermission) {
        console.warn('[AUTH] checkPermission: Permission denied', {
          permission,
          module,
          action,
          moduleExists: !!permissionsObj[module],
          actionValue: permissionsObj[module]?.[action],
          userRole: state.user.role
        });
      } else {
        console.log('[AUTH] checkPermission: Permission granted', {
          permission,
          module,
          action
        });
      }
      return hasPermission;
    }
    
    console.warn('[AUTH] checkPermission: Permissions in unexpected format', {
      permission,
      permissionsType: typeof state.user.permissions,
      permissions: state.user.permissions
    });
    return false;
  };

  // Check if user has specific role
  const hasRole = (role: UserRole): boolean => {
    if (!state.user) return false;
    return state.user.role === role;
  };

  // Get locations for a specific tenant
  const getLocationsByTenant = (tenantId: string | number): any[] => {
    console.log(`[AUTH] getLocationsByTenant(${tenantId}): state.locations.length=${state.locations?.length}`);
    
    if (!state.locations || state.locations.length === 0) {
      console.log('[AUTH] getLocationsByTenant: No locations in state');
      console.log('[AUTH] Full state:', { 
        user: state.user?.email, 
        isAuthenticated: state.isAuthenticated,
        locationsCount: state.locations?.length,
        locationsArray: state.locations
      });
      return [];
    }
    
    console.log(`[AUTH] getLocationsByTenant(${tenantId}): Checking ${state.locations.length} locations`);
    console.log('[AUTH] Location objects:', state.locations.map((loc: any) => ({
      location_id: loc.location_id,
      name: loc.name,
      tenant_id: loc.tenant_id,
      keys: Object.keys(loc)
    })));
    
    // Filter locations by tenant_id (handle both string and number comparisons)
    const filtered = state.locations.filter((location: any) => {
      const locationTenantId = String(location.tenant_id);
      const searchTenantId = String(tenantId);
      const matches = locationTenantId === searchTenantId;
      console.log(`[AUTH]   Location ${location.id}: tenant_id=${location.tenant_id} vs search=${tenantId} => ${matches}`);
      return matches;
    });
    
    console.log(`[AUTH] getLocationsByTenant(${tenantId}): Found ${filtered.length} locations out of ${state.locations.length}`);
    return filtered;
  };

  // Context value
  const contextValue: AuthContextType = {
    ...state,
    login,
    logout,
    refreshToken,
    updatePreferences,
    checkPermission,
    hasRole,
    getLocationsByTenant,
  };

  // Log locations in memory whenever they change
  React.useEffect(() => {
    if (state.locations && state.locations.length > 0) {
      console.log('📍 LOCATIONS IN MEMORY:', state.locations);
      console.log('📍 LOCATIONS COUNT:', state.locations.length);
      state.locations.forEach((loc: any, idx: number) => {
        console.log(`  [${idx}] ID: ${loc.id}, Name: ${loc.name}, Tenant: ${loc.tenant_id}`);
      });
    } else {
      console.log('📍 NO LOCATIONS IN MEMORY');
    }
  }, [state.locations]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

// Custom hook to use auth context
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;