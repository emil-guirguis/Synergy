/**
 * Supabase Storage REST client for the Rep Portal documents feature.
 *
 * Mirrors the tbwc-site rep-docs logic (admin.html / portal.html) but with no
 * @supabase/supabase-js dependency — every call is a plain fetch to
 * `${url}/storage/v1/*`, the same style as the framework's supabaseAuth wrapper.
 *
 * Docs live in a private bucket (`rep-docs`) shared with tbwc-site, organized as
 * a 2-level tree: category / subcategory / files. Folders exist implicitly (a
 * prefix with objects under it); Supabase returns them as rows with `id: null`,
 * while files carry an `id` + `metadata.size`.
 *
 * Authorization is the admin's Supabase access token (Bearer). The bucket's RLS
 * policies — defined in the shared Supabase project — gate who may write/read.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

export const DOCS_BUCKET = 'rep-docs';

export interface DocFile {
  name: string;
  /** Full object path inside the bucket, e.g. "Category/Sub/file.pdf". */
  path: string;
  size?: number;
}
export interface DocSub {
  name: string;
  files: DocFile[];
}
export interface DocCategory {
  name: string;
  files: DocFile[];
  subs: DocSub[];
}
export interface DocTree {
  rootFiles: DocFile[];
  categories: DocCategory[];
}

function storageBase(): string {
  return `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1`;
}

/** Bearer + apikey headers. Throws early if there's no session token. */
function authHeaders(): Record<string, string> {
  const token = tokenStorage.getToken();
  if (!token) throw new Error('Not signed in — please log in again.');
  return { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY };
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

interface StorageListEntry {
  name: string;
  id: string | null;
  metadata?: { size?: number } | null;
}

/** One directory listing (non-recursive) under `prefix` (""=bucket root). */
async function list(prefix: string): Promise<{ files: DocFile[]; folders: string[] }> {
  const res = await fetch(`${storageBase()}/object/list/${DOCS_BUCKET}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prefix,
      limit: 1000,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const rows = (await res.json()) as StorageListEntry[];

  const files: DocFile[] = [];
  const folders: string[] = [];
  (rows || []).forEach((e) => {
    if (e.id) {
      if (e.name === '.emptyFolderPlaceholder') return;
      files.push({
        name: e.name,
        path: prefix ? `${prefix}/${e.name}` : e.name,
        size: e.metadata?.size,
      });
    } else {
      folders.push(e.name);
    }
  });
  return { files, folders };
}

/** Walk the bucket into a 2-level category / subcategory / files tree. */
export async function listDocsTree(): Promise<DocTree> {
  const root = await list('');
  const categories: DocCategory[] = [];
  for (const cat of root.folders) {
    const lvl1 = await list(cat);
    const subs: DocSub[] = [];
    for (const sub of lvl1.folders) {
      const lvl2 = await list(`${cat}/${sub}`);
      subs.push({ name: sub, files: lvl2.files });
    }
    categories.push({ name: cat, files: lvl1.files, subs });
  }
  return { rootFiles: root.files, categories };
}

/** Upload one file to `path` (overwrites — upsert). */
export async function uploadDoc(path: string, file: File): Promise<void> {
  const res = await fetch(`${storageBase()}/object/${DOCS_BUCKET}/${encodePath(path)}`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': file.type || 'application/pdf',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: file,
  });
  if (!res.ok) throw new Error(await readError(res));
}

/** Delete a single object by path. */
export async function removeDoc(path: string): Promise<void> {
  const res = await fetch(`${storageBase()}/object/${DOCS_BUCKET}`, {
    method: 'DELETE',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [path] }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

/** Rename/move an object (used for rename — same dir, new filename). */
export async function moveDoc(fromPath: string, toPath: string): Promise<void> {
  const res = await fetch(`${storageBase()}/object/move`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: DOCS_BUCKET, sourceKey: fromPath, destinationKey: toPath }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

/** Raw signed URL (no forced download) for a private object — used to open/view it. */
async function signedUrl(path: string, expiresIn: number): Promise<string> {
  const res = await fetch(`${storageBase()}/object/sign/${DOCS_BUCKET}/${encodePath(path)}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { signedURL: string };
  return `${storageBase()}${body.signedURL}`;
}

/** Signed, time-limited download URL for a private object (forces save-as). */
export async function signedDownloadUrl(path: string, expiresIn = 60): Promise<string> {
  const url = await signedUrl(path, expiresIn);
  const name = path.slice(path.lastIndexOf('/') + 1);
  return `${url}&download=${encodeURIComponent(name)}`;
}

/** Signed URL to open a doc directly (e.g. in a new tab) — no forced download. */
export async function signedViewUrl(path: string, expiresIn = 60): Promise<string> {
  return signedUrl(path, expiresIn);
}
