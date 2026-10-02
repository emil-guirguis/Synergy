/**
 * Dev-only "log in as this user" session swap — framework-shared, app-local
 * token minting (see each app's `/users/:id/impersonate` route and the
 * backend `canImpersonate` guard in api/base/auth.ts).
 *
 * Storage-agnostic: each app passes its own `tokenStorage` singleton (every
 * app's TokenStorage exposes the same getTokenData()/storeTokens() shape).
 * The original session is stashed in sessionStorage (survives the reload a
 * session swap needs, cleared on tab close) and restored on exit.
 */

export interface ImpersonationTokenData {
  token: string;
  refreshToken: string;
  expiresAt: number;
  rememberMe: boolean;
}

export interface ImpersonationTokenStorage {
  getTokenData(): ImpersonationTokenData | null;
  storeTokens(token: string, refreshToken: string, expiresIn: number, rememberMe?: boolean): void;
}

export interface ImpersonationSession {
  token: string;
  refreshToken: string;
  expiresIn: number;
}

const BACKUP_KEY = '__impersonation_backup__';

interface StoredBackup extends ImpersonationTokenData {
  /** Who you're viewing as — shown on the exit banner. */
  targetLabel: string;
}

function readBackup(): StoredBackup | null {
  const raw = sessionStorage.getItem(BACKUP_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredBackup;
  } catch {
    return null;
  }
}

/** Stash the caller's own session and switch storage to the target's. */
export function beginImpersonation(
  storage: ImpersonationTokenStorage,
  target: ImpersonationSession,
  targetLabel: string
): void {
  const current = storage.getTokenData();
  if (!current) throw new Error('No active session to impersonate from');
  const backup: StoredBackup = { ...current, targetLabel };
  sessionStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
  storage.storeTokens(target.token, target.refreshToken, target.expiresIn, false);
}

export function isImpersonating(): boolean {
  return sessionStorage.getItem(BACKUP_KEY) !== null;
}

/** Label of who you're currently viewing as, for the banner. */
export function impersonationTargetLabel(): string | null {
  return readBackup()?.targetLabel ?? null;
}

/** The stashed original session, if any — apps with extra session mirrors
 * (e.g. TBWC's shared-session localStorage record) read this to restore them
 * alongside storage.storeTokens(). */
export function impersonationBackup(): ImpersonationTokenData | null {
  const backup = readBackup();
  if (!backup) return null;
  const { targetLabel, ...tokenData } = backup;
  void targetLabel;
  return tokenData;
}

/** Restore the stashed session. Returns false if there was nothing to restore. */
export function endImpersonation(storage: ImpersonationTokenStorage): boolean {
  const backup = readBackup();
  if (!backup) return false;
  sessionStorage.removeItem(BACKUP_KEY);
  const expiresIn = Math.max(60, Math.round((backup.expiresAt - Date.now()) / 1000));
  storage.storeTokens(backup.token, backup.refreshToken, expiresIn, backup.rememberMe);
  return true;
}
