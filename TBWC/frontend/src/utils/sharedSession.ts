/**
 * Same-origin session bridge to the TBWC marketing site.
 *
 * The portal is served from tbwctechnology.com/portal/ — the same origin as the
 * site — so both apps see one localStorage. The site signs in with supabase-js,
 * which persists the session under `sb-<project-ref>-auth-token`; this module
 * reads and writes that same record so a rep who signed in out front is already
 * signed in here, and vice versa. No token ever crosses an origin, and there is
 * only ever one session (one refresh-token family) between the two apps.
 *
 * Shape is supabase-js v2's: the session object, JSON-stringified, with
 * `expires_at` in epoch SECONDS. Parsing is deliberately defensive — the site
 * loads supabase-js from a CDN at @2, so this has to survive that bundle moving
 * under us (base64 envelope, v1-style `currentSession` nesting).
 */
import { SUPABASE_URL } from '../config/api';

export interface SharedSession {
  access_token: string;
  refresh_token: string;
  /** Epoch seconds. Absent on older records — treat as "expiry unknown". */
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  user?: unknown;
}

/** supabase-js derives this from the project URL's first hostname label. */
export const SHARED_SESSION_KEY = (() => {
  try {
    return `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
  } catch {
    return '';
  }
})();

function parseRecord(raw: string): Record<string, unknown> | null {
  let text = raw;
  // Newer supabase-js can wrap the JSON in a base64 envelope.
  if (text.startsWith('base64-')) {
    try {
      text = atob(text.slice('base64-'.length));
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The site's current session, or null if it isn't signed in (or the record is junk). */
export function readSharedSession(): SharedSession | null {
  if (!SHARED_SESSION_KEY) return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(SHARED_SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  const record = parseRecord(raw);
  if (!record) return null;
  // v1 nested the session under currentSession; v2 stores it flat.
  const session = (record.currentSession as Record<string, unknown>) || record;

  const accessToken = session.access_token;
  const refreshToken = session.refresh_token;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') return null;

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: typeof session.expires_at === 'number' ? session.expires_at : undefined,
    expires_in: typeof session.expires_in === 'number' ? session.expires_in : undefined,
    token_type: typeof session.token_type === 'string' ? session.token_type : 'bearer',
    user: session.user,
  };
}

/**
 * Publish a session back to the shared record, so the site's tabs pick up a token
 * this app rotated instead of refreshing with one GoTrue has already retired.
 * Keeps the existing `user` when the caller doesn't carry one — the site reads
 * `session.user` straight off this record.
 */
export function writeSharedSession(session: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  user?: unknown;
}): void {
  if (!SHARED_SESSION_KEY) return;
  const previous = readSharedSession();
  const record = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + session.expires_in,
    token_type: session.token_type || 'bearer',
    user: session.user ?? previous?.user,
  };
  try {
    localStorage.setItem(SHARED_SESSION_KEY, JSON.stringify(record));
  } catch {
    /* storage full/blocked — the portal still has its own copy */
  }
}

/** Sign-out is site-wide: one session, so clearing it here signs the site out too. */
export function clearSharedSession(): void {
  if (!SHARED_SESSION_KEY) return;
  try {
    localStorage.removeItem(SHARED_SESSION_KEY);
    localStorage.removeItem(`${SHARED_SESSION_KEY}-user`);
  } catch {
    /* ignore */
  }
}

/** True when the site has a session on this origin (cheap check for bootstrap). */
export function hasSharedSession(): boolean {
  return readSharedSession() !== null;
}
