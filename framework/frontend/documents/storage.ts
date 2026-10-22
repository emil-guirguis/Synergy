/**
 * Storage backend for the documents grid, brokered by the app's own Worker.
 *
 * The browser never calls a permission-gated bucket with its own token: it asks
 * the Worker (`${apiBaseUrl}/documents/storage/*`), which authorizes in code
 * against the caller's role permissions and hands back a signed URL minted with
 * the service-role key. Bucket RLS carries no permission logic of its own, so a
 * new role made in Settings > Roles works without a database migration.
 *
 * Bytes still go straight between the browser and storage — uploads PUT to a
 * signed upload URL, views open a signed GET URL — never through the Worker.
 */
import type { DocumentStorage, StoredObjectStat } from './types';

export interface WorkerStorageConfig {
  /** e.g. "https://api.example.com/api" — the routes live at `${apiBaseUrl}/documents/storage`. */
  apiBaseUrl: string;
  /** Current access token, or null when signed out. */
  getToken: () => string | null;
  /** Bucket the Worker brokers (recorded on each document row). */
  bucket: string;
  /** Lifetime of the view URLs handed to a new tab. Default 60s. */
  signedUrlTtl?: number;
  /** Override if an app mounts the routes somewhere other than /documents. */
  path?: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
}

async function readStorageError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.message || body.error || body.msg || `Storage request failed (${res.status})`;
  } catch {
    return `Storage request failed (${res.status})`;
  }
}

export function createWorkerDocumentStorage(config: WorkerStorageConfig): DocumentStorage {
  const base = `${config.apiBaseUrl.replace(/\/$/, '')}${config.path ?? '/documents'}/storage`;
  const ttl = config.signedUrlTtl ?? 60;

  async function call<T>(route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = config.getToken();
    if (!token) throw new Error('Not signed in — please log in again.');
    const res = await fetch(`${base}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
    const parsed = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
    if (!res.ok || parsed.success === false) {
      throw new Error(parsed.message || `Request failed (${res.status})`);
    }
    return parsed.data as T;
  }

  return {
    bucket: config.bucket,

    async upload(path: string, file: File, signal?: AbortSignal): Promise<void> {
      const { url } = await call<{ url: string }>('upload-url', { path }, signal);
      // Paths carry a random prefix (storagePathFor), and the Worker signs with
      // upsert off, so a collision fails loudly instead of overwriting.
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'cache-control': 'max-age=3600' },
        body: file,
        signal,
      });
      if (!res.ok) throw new Error(await readStorageError(res));
    },

    async remove(path: string, signal?: AbortSignal): Promise<void> {
      await call('remove', { path }, signal);
    },

    async viewUrl(path: string, ttlSeconds?: number): Promise<string> {
      const { url } = await call<{ url: string }>('view-url', { path, expiresIn: ttlSeconds ?? ttl });
      return url;
    },

    async stat(path: string, signal?: AbortSignal): Promise<StoredObjectStat> {
      return call<StoredObjectStat>('stat', { path }, signal);
    },
  };
}
