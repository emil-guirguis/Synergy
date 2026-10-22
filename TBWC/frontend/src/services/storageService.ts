/**
 * Supabase Storage REST client for the Portal documents feature.
 *
 * Every call goes through the TBWC Worker (`/api/doc-types/storage/*`), never
 * to the bucket with the user's own token: the Worker checks resource:read /
 * resource:write and the employee-only type, then lists/moves/deletes or mints a
 * signed URL with the service-role key. Bytes still go browser <-> Storage
 * direct (signed upload/view URLs).
 *
 * Docs live in a private bucket (`rep-docs`) shared with tbwc-site, organized as
 * a 2-level tree: category / subcategory / files. Folders exist implicitly (a
 * prefix with objects under it); Supabase returns them as rows with `id: null`,
 * while files carry an `id` + `metadata.size`.
 *
 * Permissions live in code (role grants), not bucket RLS, so a new custom role
 * works without a database migration.
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import { withAuthRetry } from '../utils/authRetry';

export const DOCS_BUCKET = 'rep-docs';

export interface DocFile {
  name: string;
  /** Full object path inside the bucket, e.g. "Category/Sub/file.pdf". */
  path: string;
  size?: number;
}
/** A folder at any depth — nests arbitrarily (drag-dropped OS folders can go deeper than the 2 levels the upload form offers). */
export interface DocCategory {
  name: string;
  /** Full folder path, e.g. "Category/Sub/Sub2". */
  path: string;
  files: DocFile[];
  subs: DocCategory[];
  /** false = stub node (name known, children not fetched yet) from a lazy listing. Absent/true = children are real. */
  loaded?: boolean;
}
export interface DocTree {
  rootFiles: DocFile[];
  categories: DocCategory[];
}

/** POST one /doc-types/storage/* route; unwraps the { success, data } envelope. */
async function call<T>(route: string, body: Record<string, unknown>): Promise<T> {
  return withAuthRetry(async () => {
    const token = tokenStorage.getToken();
    if (!token) throw new Error('Not signed in — please log in again.');
    const res = await fetch(`${API_BASE_URL}/doc-types/storage/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok || parsed.success === false) throw new Error(parsed.message || `Request failed (${res.status})`);
    return parsed.data as T;
  });
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

/** Caps concurrent `list()` calls across the whole tree walk — full Promise.all fan-out
 * opens one Storage/Postgres connection per folder at once and trips Supabase's connection
 * cap; fully sequential is safe but slow. This bounds concurrency instead of killing it. */
function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            const next = queue.shift();
            if (next) next();
          });
      };
      if (active < max) run();
      else queue.push(run);
    });
  };
}
const limitListCall = createLimiter(4);

/** One directory listing (non-recursive) under `prefix` (""=bucket root). */
async function list(prefix: string): Promise<{ files: DocFile[]; folders: string[] }> {
  return limitListCall(() => listRaw(prefix));
}

async function listRaw(prefix: string): Promise<{ files: DocFile[]; folders: string[] }> {
  const rows = await call<StorageListEntry[]>('list', { prefix });

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

/** Walk `path` and all its descendants into folder nodes, however deep (OS drag-drop can nest arbitrarily).
 * Fan-out is back to Promise.all — `list()` itself is concurrency-capped now, so this
 * stays parallel (fast) without re-tripping Supabase's connection limit. */
async function listFolder(name: string, path: string): Promise<DocCategory> {
  const { files, folders } = await list(path);
  const subs = await Promise.all(folders.map((sub) => listFolder(sub, `${path}/${sub}`)));
  return { name, path, files, subs, loaded: true };
}

/** Walk the whole bucket into an arbitrarily-deep folder tree — every node fully fetched.
 * Used only for the "show counts" opt-in, since this is the only way to get an accurate
 * recursive file count per folder. */
export async function listDocsTree(): Promise<DocTree> {
  const root = await list('');
  const categories = await Promise.all(root.folders.map((cat) => listFolder(cat, cat)));
  return { rootFiles: root.files, categories };
}

/** Root-only listing — one request, folders come back as unloaded stubs. Pair with
 * `loadFolderChildren` to fetch a folder's contents the moment the user expands it. */
export async function loadRootChildren(): Promise<DocTree> {
  const root = await list('');
  const categories: DocCategory[] = root.folders.map((name) => ({
    name,
    path: name,
    files: [],
    subs: [],
    loaded: false,
  }));
  return { rootFiles: root.files, categories };
}

/** One folder's direct children (files + stub subfolders), fetched on demand. */
export async function loadFolderChildren(path: string): Promise<{ files: DocFile[]; subs: DocCategory[] }> {
  const { files, folders } = await list(path);
  const subs: DocCategory[] = folders.map((name) => ({
    name,
    path: `${path}/${name}`,
    files: [],
    subs: [],
    loaded: false,
  }));
  return { files, subs };
}

/** Upload one file to `path` (overwrites — upsert). */
export async function uploadDoc(path: string, file: File): Promise<void> {
  const { url } = await call<{ url: string }>('upload-url', { path });
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/pdf', 'cache-control': 'max-age=3600' },
    body: file,
  });
  if (!res.ok) throw new Error(await readError(res));
}

/** Delete a single object by path. */
export async function removeDoc(path: string): Promise<void> {
  await call('remove', { path });
}

/** Rename/move an object (used for rename — same dir, new filename). */
export async function moveDoc(fromPath: string, toPath: string): Promise<void> {
  await call('move', { fromPath, toPath });
}

/** Raw signed URL (no forced download) for a private object — used to open/view it. */
async function signedUrl(path: string, expiresIn: number, download = false): Promise<string> {
  const { url } = await call<{ url: string }>('view-url', { path, expiresIn, download });
  return url;
}

/** Signed, time-limited download URL for a private object (forces save-as). */
export async function signedDownloadUrl(path: string, expiresIn = 60): Promise<string> {
  return signedUrl(path, expiresIn, true);
}

/** Signed URL to open a doc directly (e.g. in a new tab) — no forced download. */
export async function signedViewUrl(path: string, expiresIn = 60): Promise<string> {
  return signedUrl(path, expiresIn);
}
