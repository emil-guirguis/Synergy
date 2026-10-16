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

const AUTH_ERROR_PATTERNS: RegExp[] = [
  /invalid or expired token/,
  /access token required/,
  /unauthorized/,
  /authentication required/,
  // Supabase Storage/PostgREST's jose-based JWT verification. The claim name's
  // quoting is NOT stable: it has been emitted both as 'exp' and as "exp"
  // (2026-10-16: a multi-hour quote import died on every upload once the token
  // aged out, because this list only matched the single-quoted spelling and so
  // never triggered the refresh below). Match either, or none.
  /["']?exp["']? claim timestamp check failed/,
  /jwt expired/,
  /token (?:is |has )?expired/,
];

export function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return AUTH_ERROR_PATTERNS.some((p) => p.test(message));
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
