/**
 * Service-role Supabase Storage calls for the Worker.
 *
 * The browser no longer talks to permission-gated buckets with its own token:
 * every read/write is authorized here, in code, against the caller's
 * PermissionSet (role_permission + overrides), and only then does the Worker
 * touch Storage with the service-role key. Bucket RLS is a deny-all backstop
 * with no logic of its own — so a new custom role made in Settings > Roles
 * works the moment it's saved, no migration.
 *
 * Bytes still never pass through the Worker for user transfers: viewing hands
 * back a short-lived signed URL, uploading hands back a signed upload URL the
 * browser PUTs to directly.
 */
import { Env } from './db';

export class StorageAdminError extends Error {
  constructor(message: string, public status: 400 | 404 | 500 = 500) {
    super(message);
  }
}

function config(env: Env): { base: string; key: string } {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new StorageAdminError('Supabase service role key not configured');
  }
  return { base: `${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1`, key: env.SUPABASE_SERVICE_ROLE_KEY };
}

function headers(key: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra };
}

/** Encode each path segment but keep the "/" separators. */
export function encodeStoragePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Supabase answers a missing object with HTTP 400 and the 404 only inside the
 * JSON body (`{"statusCode":"404","error":"not_found",...}`).
 */
async function isNotFound(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.ok) return false;
  const text = await res.clone().text().catch(() => '');
  return /"statusCode"\s*:\s*"?404|not_found|NoSuchKey/i.test(text);
}

async function readError(res: Response): Promise<string> {
  try {
    const body: any = await res.json();
    return body.message || body.error || `Storage request failed (${res.status})`;
  } catch {
    return `Storage request failed (${res.status})`;
  }
}

/** Absolute signed GET URL for one object. */
export async function signObjectUrl(env: Env, bucket: string, path: string, expiresIn: number): Promise<string> {
  const { base, key } = config(env);
  const res = await fetch(`${base}/object/sign/${bucket}/${encodeStoragePath(path)}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn }),
  });
  if (await isNotFound(res)) throw new StorageAdminError('File not found in storage', 404);
  if (!res.ok) throw new StorageAdminError(await readError(res));
  const body = (await res.json()) as { signedURL: string };
  return `${base}${body.signedURL}`;
}

/**
 * Absolute signed upload URL — the browser PUTs the file body to it, no auth
 * header needed (the token is in the query string). `upsert` false makes a
 * path collision fail instead of silently overwriting.
 */
export async function signUploadUrl(env: Env, bucket: string, path: string, upsert = false): Promise<string> {
  const { base, key } = config(env);
  const res = await fetch(`${base}/object/upload/sign/${bucket}/${encodeStoragePath(path)}`, {
    method: 'POST',
    headers: headers(key, upsert ? { 'x-upsert': 'true' } : undefined),
  });
  if (!res.ok) throw new StorageAdminError(await readError(res));
  const body = (await res.json()) as { url: string };
  return `${base}${body.url}`;
}

/**
 * Direct service-role upload of bytes built server-side (a generated PDF) —
 * unlike signUploadUrl, nothing is ever handed to the browser. `x-upsert` so
 * writing to the same path twice (e.g. a retried request) overwrites instead
 * of 409ing.
 */
export async function putObject(env: Env, bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { base, key } = config(env);
  const res = await fetch(`${base}/object/${bucket}/${encodeStoragePath(path)}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': contentType, 'x-upsert': 'true' }),
    // Same DOM-lib/pdf-lib ArrayBufferLike mismatch as the Blob cast
    // elsewhere (documentEmail.ts) — never actually shared memory here.
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new StorageAdminError(await readError(res));
}

/** Delete objects by path. Missing objects are not an error. */
export async function removeObjects(env: Env, bucket: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { base, key } = config(env);
  const res = await fetch(`${base}/object/${bucket}`, {
    method: 'DELETE',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) throw new StorageAdminError(await readError(res));
}

/** Move/rename one object inside a bucket. */
export async function moveObject(env: Env, bucket: string, fromPath: string, toPath: string): Promise<void> {
  const { base, key } = config(env);
  const res = await fetch(`${base}/object/move`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ bucketId: bucket, sourceKey: fromPath, destinationKey: toPath }),
  });
  if (!res.ok) throw new StorageAdminError(await readError(res));
}

export interface StorageListEntry {
  name: string;
  id: string | null;
  metadata?: { size?: number } | null;
}

/** One non-recursive directory listing under `prefix` ("" = bucket root). */
export async function listObjects(env: Env, bucket: string, prefix: string): Promise<StorageListEntry[]> {
  const { base, key } = config(env);
  const res = await fetch(`${base}/object/list/${bucket}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new StorageAdminError(await readError(res));
  return ((await res.json()) as StorageListEntry[]) || [];
}

export type ObjectStat = { status: 'found'; size: number | null } | { status: 'missing' } | { status: 'unknown' };

/**
 * Do the bytes really exist? A one-byte ranged GET, not a HEAD — HEAD answers
 * from the metadata row and says 200 for a path whose bytes are gone. Size
 * comes from the 206's content-range (readable server-side, unlike in a
 * browser where it isn't CORS-exposed).
 */
export async function statObject(env: Env, bucket: string, path: string): Promise<ObjectStat> {
  const { base, key } = config(env);
  try {
    const res = await fetch(`${base}/object/${bucket}/${encodeStoragePath(path)}`, {
      headers: headers(key, { Range: 'bytes=0-0' }),
    });
    if (await isNotFound(res)) return { status: 'missing' };
    if (!res.ok) return { status: 'unknown' };
    const total = res.headers.get('content-range')?.split('/')[1];
    const size = total && total !== '*' ? Number(total) : Number(res.headers.get('content-length') ?? NaN);
    await res.body?.cancel().catch(() => undefined);
    return { status: 'found', size: Number.isFinite(size) ? size : null };
  } catch {
    return { status: 'unknown' };
  }
}
