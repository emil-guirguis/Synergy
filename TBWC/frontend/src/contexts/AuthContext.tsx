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
import type { LoginCredentials, User } from '../types/auth';

export interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isAdmin: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  checkPermission: (permission?: string) => boolean;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Bootstrap: restore a session if a valid token is present.
  useEffect(() => {
    let active = true;
    (async () => {
      if (tokenStorage.getToken()) {
        const u = await authService.loadCurrentUser();
        if (active) setUser(u);
      }
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

  // Admins can perform any action; everyone authenticated can read.
  const isAdmin = !!user?.is_admin;
  const checkPermission = useCallback(
    (_permission?: string) => isAdmin,
    [isAdmin]
  );

  const value: AuthContextValue = {
    user,
    isAuthenticated: !!user,
    isLoading,
    isAdmin,
    login,
    logout,
    checkPermission,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
