/**
 * Supabase Storage backend for the documents grid.
 *
 * Plain fetch against `${url}/storage/v1/*` — no @supabase/supabase-js dependency,
 * same style as framework/frontend/auth/supabaseAuth.ts and TBWC's storageService.
 * The browser uploads with the signed-in user's own access token, so the bucket's
 * RLS policies decide who may write/read; file bytes never touch the app's Worker.
 */
import type { DocumentStorage } from './types';

export interface SupabaseStorageConfig {
  /** Project URL, e.g. https://xxxx.supabase.co */
  supabaseUrl: string;
  /** Public anon key (sent as the apikey header). */
  anonKey: string;
  /** Current Supabase access token, or null when signed out. */
  getToken: () => string | null;
  /** Private bucket holding record attachments. */
  bucket: string;
  /** Lifetime of the view URLs handed to a new tab. Default 60s. */
  signedUrlTtl?: number;
}

function storageBase(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1`;
}

/** Encode each path segment but keep the "/" separators. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.message || body.error || body.msg || `Storage request failed (${res.status})`;
  } catch {
    return `Storage request failed (${res.status})`;
  }
}

export function createSupabaseDocumentStorage(config: SupabaseStorageConfig): DocumentStorage {
  const base = storageBase(config.supabaseUrl);
  const ttl = config.signedUrlTtl ?? 60;

  const authHeaders = (): Record<string, string> => {
    const token = config.getToken();
    if (!token) throw new Error('Not signed in — please log in again.');
    return { Authorization: `Bearer ${token}`, apikey: config.anonKey };
  };

  return {
    bucket: config.bucket,

    async upload(path: string, file: File): Promise<void> {
      const res = await fetch(`${base}/object/${config.bucket}/${encodePath(path)}`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': file.type || 'application/octet-stream',
          // Paths carry a random prefix (storagePathFor), so a collision here
          // means something is wrong — fail loudly instead of overwriting.
          'x-upsert': 'false',
          'cache-control': '3600',
        },
        body: file,
      });
      if (!res.ok) throw new Error(await readError(res));
    },

    async remove(path: string): Promise<void> {
      const res = await fetch(`${base}/object/${config.bucket}`, {
        method: 'DELETE',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [path] }),
      });
      if (!res.ok) throw new Error(await readError(res));
    },

    async viewUrl(path: string): Promise<string> {
      const res = await fetch(`${base}/object/sign/${config.bucket}/${encodePath(path)}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: ttl }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { signedURL: string };
      return `${base}${body.signedURL}`;
    },
  };
}
