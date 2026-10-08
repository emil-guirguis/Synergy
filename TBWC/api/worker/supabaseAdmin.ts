/**
 * Supabase Admin API helpers — service-role calls to GoTrue used by the
 * Users module (routes/users.ts): minting a session for impersonation, and
 * creating/deleting the auth.users row behind an admin-created profile.
 *
 * mintSessionForEmail: dev-only impersonation route (`/:id/impersonate`,
 * gated by the framework's canImpersonate single-email check) — never
 * exposed otherwise. GoTrue has no direct "create a session for this user
 * id" endpoint, so this uses the documented two-step trick: generate a
 * magiclink server-side (nothing is emailed — we only want the token it
 * carries) and immediately redeem its hashed_token for a session via /verify.
 */
import { Env } from './db';

export interface MintedSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function mintSessionForEmail(env: Env, email: string): Promise<MintedSession> {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  const base = env.SUPABASE_URL.replace(/\/$/, '');

  const linkRes = await fetch(`${base}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!linkRes.ok) {
    throw new Error(`generate_link failed (${linkRes.status}): ${await linkRes.text()}`);
  }
  // Response shape has varied across GoTrue versions — top-level hashed_token
  // on newer ones, nested under `properties` on older ones.
  const link = (await linkRes.json()) as { hashed_token?: string; properties?: { hashed_token?: string } };
  const hashedToken = link.hashed_token || link.properties?.hashed_token;
  if (!hashedToken) throw new Error('generate_link response had no hashed_token');

  const verifyRes = await fetch(`${base}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  if (!verifyRes.ok) {
    throw new Error(`verify failed (${verifyRes.status}): ${await verifyRes.text()}`);
  }
  const session = (await verifyRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!session.access_token || !session.refresh_token) {
    throw new Error('verify response had no session tokens');
  }
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? 3600,
  };
}

/**
 * Create an auth.users row directly via the Admin API — skips tbwc-site's
 * public rep-signup flow entirely (no password, no confirmation email;
 * email_confirm:true marks it verified right away). public.users.id is a
 * FK to auth.users(id) with no default, so this must run before the
 * matching profile row can be inserted. The admin creating the user can
 * hand them a magic link afterward (mintSessionForEmail) to set a password.
 */
export async function createAuthUser(env: Env, email: string): Promise<{ id: string }> {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  const base = env.SUPABASE_URL.replace(/\/$/, '');

  const res = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { msg?: string; message?: string; error_description?: string };
      message = parsed.msg || parsed.message || parsed.error_description || text;
    } catch {
      // not JSON — keep raw text
    }
    throw new Error(message || `create auth user failed (${res.status})`);
  }
  const user = (await res.json()) as { id?: string };
  if (!user.id) throw new Error('create auth user response had no id');
  return { id: user.id };
}

/** Rolls back createAuthUser() when the matching public.users insert fails. */
export async function deleteAuthUser(env: Env, id: string): Promise<void> {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return;
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  await fetch(`${base}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).catch(() => {});
}
