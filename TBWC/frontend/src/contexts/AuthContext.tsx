import {
  createContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { authService } from '../services/authService';
import { tokenStorage } from '../utils/tokenStorage';
import { resetAllEntityStores } from '../store/slices/createEntitySlice';
import { setSystemConfig } from '@meterit/framework-frontend/utils';
import type { LoginCredentials, User } from '../types/auth';

// checkPermission() takes the frontend's create/update/delete-shaped
// Permission enum (types/auth.ts) — list components were written against
// that shape — but user.permissions (and scopeOf) only ever carries the
// backend's read/write/delete catalog (permissions.ts's PERMISSIONS). This
// is the one-time translation between the two; a key absent here (anything
// already backend-shaped, e.g. 'aichat:use', 'report:read') passes through
// scopeOf unchanged.
const BACKEND_PERMISSION: Record<string, string> = {
  'user:create': 'user:write',
  'user:update': 'user:write',
  'user:delete': 'user:write',
  'order:create': 'order:write',
  'order:update': 'order:write',
  'order:delete': 'order:delete',
  'inventory:create': 'inventory:write',
  'inventory:update': 'inventory:write',
  'inventory:delete': 'inventory:write',
  'quote:create': 'quote:write',
  'quote:update': 'quote:write',
  'quote:delete': 'quote:delete',
};

export interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isAdmin: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  /** Self-service display preference override — see authService.updatePreferences. */
  updatePreferences: (updates: Partial<Pick<User, 'timezone' | 'date_format' | 'time_format' | 'default_page_size'>>) => Promise<void>;
  checkPermission: (permission?: string) => boolean;
  /** The role-granted scope for a permission ('all' | 'own'), or null if not held. */
  scopeOf: (permission: string) => 'all' | 'own' | null;
  /** Field-level security: false if the permission isn't held, the field is
   *  in its hidden_fields, or its fieldAccess marks view:false. `field` is a
   *  plain name or, one level into a jsonb array column, `column[].field`
   *  (e.g. `lines[].rate`) — same addressing as the role's hidden_fields. */
  isFieldVisible: (permission: string, field: string) => boolean;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Bootstrap: restore a session if a valid token is present.
  useEffect(() => {
    let active = true;
    (async () => {
      // The portal is served from the same origin as tbwctechnology.com, so the
      // site's session sits in this localStorage. It outranks anything this app
      // stored: it names whoever signed in out front most recently, which may be a
      // different rep than last used this tab. Adopting it is the auto-login.
      let u: User | null = null;
      if (authService.hasSharedSession()) {
        u = await authService.adoptSharedSession();
        if (u) resetAllEntityStores();
      }
      if (!u && tokenStorage.getToken()) {
        u = await authService.loadCurrentUser();
      }
      if (active) setUser(u);
      if (active) setIsLoading(false);
    })();

    const onForceLogout = () => {
      resetAllEntityStores();
      setUser(null);
    };
    window.addEventListener('auth:force-logout', onForceLogout);
    return () => {
      active = false;
      window.removeEventListener('auth:force-logout', onForceLogout);
    };
  }, []);

  // Mirror the authenticated user's resolved display preferences (org default,
  // overridden per-user — see loadProfile()'s COALESCE) onto the framework's
  // System Config store, so formatDate/formatCurrency/etc. pick them up
  // anywhere in the app without drilling the user object through every call site.
  useEffect(() => {
    setSystemConfig({
      timezone: user?.timezone ?? null,
      date_format: user?.date_format ?? null,
      time_format: user?.time_format ?? null,
      currency: user?.currency ?? null,
      default_page_size: user?.default_page_size ?? null,
    });
  }, [user]);

  // The entity stores (orders, invoices, users, ...) are module singletons that
  // outlive a session: signing out clears the token and this context, but never
  // reloads the page, so their cached rows/filters/lastFetch survive into the
  // next sign-in. That let a rep open Orders and be served the admin's cached,
  // unscoped list (cache still fresh, so no request was made at all), or land on
  // an empty list left filtered by the previous session. Wipe them on both edges
  // of the session, not just logout — a token can also go away without logout().
  const login = useCallback(async (credentials: LoginCredentials) => {
    const res = await authService.login(credentials);
    resetAllEntityStores();
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    await authService.logout();
    resetAllEntityStores();
    setUser(null);
  }, []);

  const updatePreferences = useCallback(async (updates: Partial<Pick<User, 'timezone' | 'date_format' | 'time_format' | 'default_page_size'>>) => {
    const updated = await authService.updatePreferences(updates);
    setUser(updated);
  }, []);

  // is_admin still exists on the row (legacy — role_id is authoritative,
  // see middleware.ts's loadProfile), kept here only for UI copy that
  // genuinely means "the Administrator role" (e.g. an impersonation banner),
  // not for gating features — those read real grants via scopeOf below.
  const isAdmin = !!user?.is_admin;
  const scopeOf = useCallback(
    (permission: string) => user?.permissions?.find((g) => g.permission === permission)?.scope ?? null,
    [user]
  );
  // No permission given means "nothing specific required" — true, same as
  // before. Otherwise: translate the frontend's create/update/delete-shaped
  // Permission enum to the backend key if needed, then check the caller
  // actually holds it (either scope — 'own' still means "show the create/
  // edit control," row-level narrowing is the API's job, not the UI's).
  const checkPermission = useCallback(
    (permission?: string) => !permission || scopeOf(BACKEND_PERMISSION[permission] ?? permission) !== null,
    [scopeOf]
  );
  const isFieldVisible = useCallback(
    (permission: string, field: string) => {
      const grant = user?.permissions?.find((g) => g.permission === permission);
      if (!grant) return false;
      if (grant.hiddenFields.includes(field)) return false;
      return grant.fieldAccess?.[field]?.view !== false;
    },
    [user]
  );

  const value: AuthContextValue = {
    user,
    isAuthenticated: !!user,
    isLoading,
    isAdmin,
    login,
    logout,
    updatePreferences,
    checkPermission,
    scopeOf,
    isFieldVisible,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
