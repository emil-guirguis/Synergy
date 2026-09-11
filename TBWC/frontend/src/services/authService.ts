/**
 * TBWC auth service.
 *
 * Login is a standard HTTPS fetch to the Supabase Auth REST API (via the shared
 * framework client) — the same path every framework app uses. The returned
 * Supabase access token is then sent as a Bearer token to the TBWC data API,
 * which verifies it against the same Supabase project.
 *
 * Exposes the surface the store middleware + auth context depend on
 * (login, logout, refresh, loadCurrentUser, setLogoutFlag, clearStoredToken).
 */
import { createSupabaseAuth } from '@meterit/framework-frontend/auth/supabaseAuth';
import { tokenStorage } from '../utils/tokenStorage';
import {
  clearSharedSession,
  hasSharedSession,
  readSharedSession,
  writeSharedSession,
} from '../utils/sharedSession';
import { API_BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/api';
import type { AuthResponse, LoginCredentials, User } from '../types/auth';

const LOGOUT_FLAG_KEY = 'explicit_logout';
const supabaseAuth = createSupabaseAuth({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });

/** In flight/settled adoption of the site's session — see adoptSharedSession(). */
let adoption: Promise<User | null> | null = null;

/** GET the authenticated user's tbwc profile from the data API. */
async function fetchProfile(accessToken: string): Promise<User> {
  // Bound the request: if the API is down/wedged, fail fast so the app bootstrap
  // falls back to the login page instead of spinning forever on `isLoading`.
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new Error(`Data API did not respond (${API_BASE_URL}). Is the TBWC worker running on 8788?`);
    }
    throw new Error(`Cannot reach data API (${API_BASE_URL}).`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Failed to load profile (${res.status})`);
  }
  const data = await res.json();
  return data.data as User;
}

function withName(user: User): User {
  return {
    ...user,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || '',
  };
}

class AuthService {
  /** Validate credentials against Supabase Auth, then load + gate the profile. */
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    const { email, password, rememberMe = false } = credentials;
    const res = await supabaseAuth.signInWithPassword(email, password);
    if (res.error || !res.data) {
      throw new Error(res.error || 'Invalid login credentials');
    }
    const session = res.data;

    // Store tokens before the profile call (it needs the bearer token).
    tokenStorage.storeTokens(session.access_token, session.refresh_token, session.expires_in, rememberMe);
    // Same origin as the marketing site: publish the session so signing in here
    // signs the rep into tbwctechnology.com too (and vice versa — see adoptSharedSession).
    writeSharedSession(session);
    this.clearLogoutFlag();

    let profile: User;
    try {
      profile = await fetchProfile(session.access_token);
    } catch (e) {
      tokenStorage.clearTokens();
      throw e;
    }

    // Approval gate — mirrors the live tbwc-site sign-in.
    if (!profile.approved) {
      tokenStorage.clearTokens();
      throw new Error('Your registration is still pending approval.');
    }

    return {
      token: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      user: withName(profile),
    };
  }

  /** True when the site (same origin) has a session this app can adopt. */
  hasSharedSession(): boolean {
    return hasSharedSession();
  }

  /**
   * Adopt the site's session as this app's own — the auto-login path for a rep who
   * signed in at tbwctechnology.com and clicked through to /portal/.
   *
   * Memoised: StrictMode runs the bootstrap effect twice, and a duplicate refresh
   * is exactly the call that gets a refresh token retired out from under the site.
   */
  adoptSharedSession(): Promise<User | null> {
    if (!adoption) adoption = this.doAdoptSharedSession();
    return adoption;
  }

  private async doAdoptSharedSession(): Promise<User | null> {
    const shared = readSharedSession();
    if (!shared) return null;

    let accessToken = shared.access_token;
    const expiresAtMs = shared.expires_at ? shared.expires_at * 1000 : 0;

    // Unknown or near-dead access token: rotate it and hand the new one back to the
    // site, so both apps stay on the same (single) refresh-token family.
    if (expiresAtMs - Date.now() < 60_000) {
      const res = await supabaseAuth.refreshSession(shared.refresh_token);
      if (res.error || !res.data) return null;
      const s = res.data;
      accessToken = s.access_token;
      tokenStorage.storeTokens(s.access_token, s.refresh_token, s.expires_in, false);
      writeSharedSession(s);
    } else {
      const expiresIn = Math.floor((expiresAtMs - Date.now()) / 1000);
      tokenStorage.storeTokens(shared.access_token, shared.refresh_token, expiresIn, false);
    }
    this.clearLogoutFlag();

    try {
      const profile = await fetchProfile(accessToken);
      // Same approval gate as login() and the site's own sign-in.
      if (!profile.approved) {
        tokenStorage.clearTokens();
        return null;
      }
      return withName(profile);
    } catch {
      tokenStorage.clearTokens();
      return null;
    }
  }

  /** Load the current user if a valid token exists (app bootstrap). */
  async loadCurrentUser(): Promise<User | null> {
    const token = tokenStorage.getToken();
    if (!token) return null;
    try {
      return withName(await fetchProfile(token));
    } catch {
      return null;
    }
  }

  /** Refresh the Supabase session; returns the new access token or null. */
  async refresh(): Promise<string | null> {
    const refreshToken = tokenStorage.getRefreshToken();
    if (!refreshToken) return null;
    const res = await supabaseAuth.refreshSession(refreshToken);
    if (res.error || !res.data) return null;
    const s = res.data;
    tokenStorage.storeTokens(s.access_token, s.refresh_token, s.expires_in, false);
    writeSharedSession(s);
    return s.access_token;
  }

  async logout(): Promise<void> {
    const token = tokenStorage.getToken();
    if (token) await supabaseAuth.signOut(token);
    this.setLogoutFlag();
    tokenStorage.clearTokens();
    // One session across both apps, so signing out here signs out the site too —
    // leaving its record behind would just have the next /portal/ load adopt it again.
    clearSharedSession();
    adoption = null;
  }

  // --- helpers used by the store api middleware ---
  getToken(): string | null {
    return tokenStorage.getToken();
  }
  clearStoredToken(): void {
    tokenStorage.clearTokens();
    // Reached when the API rejects the token: the shared record holds the same dead
    // session, so leave it and bootstrap would adopt it straight back.
    clearSharedSession();
    adoption = null;
  }
  setLogoutFlag(): void {
    try { localStorage.setItem(LOGOUT_FLAG_KEY, 'true'); } catch { /* ignore */ }
  }
  clearLogoutFlag(): void {
    try { localStorage.removeItem(LOGOUT_FLAG_KEY); } catch { /* ignore */ }
  }
}

export const authService = new AuthService();
export default authService;
