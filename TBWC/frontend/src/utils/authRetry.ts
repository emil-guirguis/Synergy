/**
 * Shared "detect expired-token error, refresh once, retry" wrapper.
 *
 * Access tokens expire mid-session and nothing refreshes them proactively —
 * any call can be the first one to hit an expired token. The TBWC Worker's own
 * auth middleware (framework/auth.ts) rejects with one set of messages; Supabase
 * Storage — hit directly by the documents module, bypassing the Worker entirely
 * (framework/frontend/documents/storage.ts) — rejects with its own JWT-library
 * message instead. Both need to trigger the same refresh-and-retry.
 */
import { authService } from '../services/authService';

const AUTH_ERROR_PATTERNS = [
  'invalid or expired token',
  'access token required',
  'unauthorized',
  'authentication required',
  // Supabase Storage/PostgREST's jose-based JWT verification, verbatim.
  "'exp' claim timestamp check failed",
];

export function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return AUTH_ERROR_PATTERNS.some((p) => message.includes(p.toLowerCase()));
}

export function forceLogout(): void {
  authService.setLogoutFlag();
  authService.clearStoredToken();
  if (typeof window !== 'undefined') window.location.href = '/login';
}

export async function withAuthRetry<T>(call: () => Promise<T>): Promise<T> {
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
