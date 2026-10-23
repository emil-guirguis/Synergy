/**
 * Type ('rep' | 'employee' | 'all') for each file in the Supabase `rep-docs`
 * Storage bucket. Table public.document_type, PK document_type_id — see
 * migrations/015-rep-doc-type.sql for why this lives here instead of on the
 * bucket object itself (renamed from rep_doc_type in migrations/093).
 *
 * Every mutation here also keeps a mirror row in the shared public.document
 * table (entity_type='resource') so Resources get filename/content search and
 * AI-chat coverage for free via the existing document search tools — see
 * upsertResourceDocument below and migrations/089-resource-documents.sql.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { effectiveResourceType, loadResourceTypeMap } from './docAccess';
import { indexDocumentContent } from '@meterit/framework-backend/api/base/aiSearch';
import { emailStoredFile, FileEmailError } from '../fileEmail';
import {
  listObjects,
  moveObject,
  removeObjects,
  signObjectUrl,
  signUploadUrl,
  StorageAdminError,
  type StorageListEntry,
} from '../storageAdmin';

const RESOURCE_BUCKET = 'rep-docs';
const MAX_VIEW_URL_TTL = 60 * 60 * 24 * 7;

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TYPES = ['rep', 'employee', 'all'] as const;
type DocType = (typeof TYPES)[number];

function isDocType(v: unknown): v is DocType {
  return typeof v === 'string' && (TYPES as readonly string[]).includes(v);
}

/** Keeps the shared public.document table (entity_type='resource') in sync with
 *  the rep-docs bucket, so the existing document search/AI tools (aiChat.ts
 *  search_documents/search_document_contents) cover Resources too — see
 *  migrations/089-resource-documents.sql. fileSize/mimeType are only known at
 *  upload time (the file object) — a later type-only change (dropdown, no
 *  re-upload) omits them, so an existing row's values are preserved via COALESCE.
 *  Returns the row's document_id so the caller can trigger content indexing. */
async function upsertResourceDocument(
  env: Env,
  docPath: string,
  fileSize?: number | null,
  mimeType?: string | null
): Promise<number | null> {
  const fileName = docPath.slice(docPath.lastIndexOf('/') + 1);
  const result = await execQuery(
    env,
    `INSERT INTO public.document (entity_type, entity_id, doc_type, file_name, mime_type, file_size, storage_bucket, storage_path)
     VALUES ('resource', $1, 'other', $2, $3, $4, 'rep-docs', $1)
     ON CONFLICT (entity_id) WHERE entity_type = 'resource' DO UPDATE SET
       file_name = EXCLUDED.file_name,
       mime_type = COALESCE(EXCLUDED.mime_type, document.mime_type),
       file_size = COALESCE(EXCLUDED.file_size, document.file_size),
       updated_at = now()
     RETURNING document_id`,
    [docPath, fileName, mimeType ?? null, fileSize ?? null],
    'docTypes.upsertResourceDocument'
  );
  return result.rows[0]?.document_id ?? null;
}

/** 'employee' files (or anything under an 'employee' folder) are invisible
 *  without resource:write. The type map and the inheritance rule live in
 *  docAccess.ts, shared with the AI document searches — which have to hide the
 *  same files. */
async function canSeePath(c: any, path: string, types?: Map<string, DocType>): Promise<boolean> {
  if (c.get('permissions').has('resource:write')) return true;
  return effectiveResourceType(types ?? (await loadResourceTypeMap(c.env)), path) !== 'employee';
}

/** A bucket key: non-empty segments, no traversal. "" (the root) only where `allowRoot`. */
function isResourcePath(v: unknown, allowRoot = false): v is string {
  if (typeof v !== 'string' || v.length > 1024) return false;
  if (v === '') return allowRoot;
  return v.split('/').every((p) => p && p !== '.' && p !== '..');
}

function storageFail(c: any, e: unknown) {
  if (e instanceof StorageAdminError) return c.json({ success: false, message: e.message }, e.status);
  throw e;
}

// ---- Bytes. The browser has no bucket access of its own: every call below is
// authorized here (resource:read / resource:write + the employee-type rule) and
// then done with the service-role key. rep-docs RLS carries no logic.

/** One folder's direct children ("" = root), with employee-only entries removed for read-only callers. */
app.post('/storage/list', requirePermission('resource:read'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prefix = body.prefix ?? '';
  if (!isResourcePath(prefix, true)) return c.json({ success: false, message: 'Invalid prefix' }, 400);
  try {
    const entries = await listObjects(c.env, RESOURCE_BUCKET, prefix);
    const types = c.get('permissions').has('resource:write') ? undefined : await loadResourceTypeMap(c.env);
    const visible: StorageListEntry[] = [];
    for (const e of entries) {
      if (await canSeePath(c, prefix ? `${prefix}/${e.name}` : e.name, types)) visible.push(e);
    }
    return c.json({ success: true, data: visible });
  } catch (e) {
    return storageFail(c, e);
  }
});

/** Signed view (or forced-download) URL for one file the caller may see. */
app.post('/storage/view-url', requirePermission('resource:read'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isResourcePath(body.path)) return c.json({ success: false, message: 'Invalid path' }, 400);
  if (!(await canSeePath(c, body.path))) return c.json({ success: false, message: 'Not found' }, 404);
  const requested = Number(body.expiresIn);
  const ttl = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_VIEW_URL_TTL) : 60;
  try {
    let url = await signObjectUrl(c.env, RESOURCE_BUCKET, body.path, ttl);
    if (body.download) url += `&download=${encodeURIComponent(body.path.slice(body.path.lastIndexOf('/') + 1))}`;
    return c.json({ success: true, data: { url } });
  } catch (e) {
    return storageFail(c, e);
  }
});

/** Signed upload URL; overwrites an existing file at the same path (Resources re-upload replaces). */
app.post('/storage/upload-url', requirePermission('resource:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isResourcePath(body.path)) return c.json({ success: false, message: 'Invalid path' }, 400);
  try {
    return c.json({ success: true, data: { url: await signUploadUrl(c.env, RESOURCE_BUCKET, body.path, true) } });
  } catch (e) {
    return storageFail(c, e);
  }
});

app.post('/storage/remove', requirePermission('resource:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isResourcePath(body.path)) return c.json({ success: false, message: 'Invalid path' }, 400);
  try {
    await removeObjects(c.env, RESOURCE_BUCKET, [body.path]);
    return c.json({ success: true });
  } catch (e) {
    return storageFail(c, e);
  }
});

app.post('/storage/move', requirePermission('resource:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isResourcePath(body.fromPath) || !isResourcePath(body.toPath)) {
    return c.json({ success: false, message: 'Invalid path' }, 400);
  }
  try {
    await moveObject(c.env, RESOURCE_BUCKET, body.fromPath, body.toPath);
    return c.json({ success: true });
  } catch (e) {
    return storageFail(c, e);
  }
});

// { "Category/file.pdf": "rep", ... } for every file that has a type set.
// Files with no row default to 'all' on the client. A caller without
// resource:write (i.e. the read-only rep-facing view — mirrors ResourcesTab.tsx's
// readOnly filter) never sees an 'employee'-only path at all, even as bare
// metadata: that distinction used to be enforced only by the frontend's own
// filtering of this same response, which a direct API call could skip entirely.
app.get('/', requirePermission('resource:read'), async (c) => {
  const result = await execQuery(c.env, 'SELECT doc_path, doc_type FROM public.document_type');
  const canSeeEmployeeDocs = c.get('permissions').has('resource:write');
  const data: Record<string, DocType> = {};
  for (const row of result.rows) {
    if (row.doc_type === 'employee' && !canSeeEmployeeDocs) continue;
    data[row.doc_path] = row.doc_type;
  }
  return c.json({ success: true, data });
});

/**
 * Email one resource file as a real attachment (the Resources browser's share
 * menu). Read-level access — sending a cutsheet to a customer is exactly what a
 * rep's read access is for — except that an 'employee'-typed file is invisible
 * to a caller without resource:write (same rule as GET above), and must not be
 * emailable by them either.
 */
app.post('/email', requirePermission('resource:read'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const path = typeof body.path === 'string' ? body.path : '';
  if (!path) return c.json({ success: false, message: 'path is required' }, 400);

  if (!(await canSeePath(c, path))) return c.json({ success: false, message: 'Not found' }, 404);

  // mime_type comes from the mirror row when there is one; the bucket's own
  // content type is not readable from here, and a missing one falls back to
  // application/octet-stream inside emailStoredFile.
  const { rows } = await execQuery(
    c.env,
    `SELECT mime_type FROM public.document WHERE entity_type = 'resource' AND entity_id = $1`,
    [path],
    'docTypes.emailMimeType'
  );

  try {
    const recipients = await emailStoredFile(
      c.env,
      {
        bucket: RESOURCE_BUCKET,
        path,
        fileName: path.slice(path.lastIndexOf('/') + 1),
        mimeType: rows[0]?.mime_type ?? null,
      },
      { to: body.to, subject: body.subject, message: body.message, replyTo: c.get('user')?.email }
    );
    return c.json({ success: true, data: { sent: true, recipients } });
  } catch (e) {
    if (e instanceof FileEmailError) return c.json({ success: false, message: e.message }, e.status);
    throw e;
  }
});

app.put('/', requirePermission('resource:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { path, type, fileSize, mimeType } = body as {
    path?: string;
    type?: string;
    fileSize?: number;
    mimeType?: string;
  };
  if (!path) return c.json({ success: false, message: 'path is required' }, 400);
  if (!isDocType(type)) return c.json({ success: false, message: 'type must be rep, employee, or all' }, 400);

  await execQuery(
    c.env,
    `INSERT INTO public.document_type (doc_path, doc_type, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (doc_path) DO UPDATE SET doc_type = EXCLUDED.doc_type, updated_at = now()`,
    [path, type],
    'docTypes.upsert'
  );
  const documentId = await upsertResourceDocument(c.env, path, fileSize ?? null, mimeType ?? null);
  // Only a real upload carries fileSize/mimeType (see upsertResourceDocument's
  // comment) — a type-only dropdown change re-indexing the same bytes would
  // just waste a Storage fetch for no new content.
  if (documentId != null && (fileSize != null || mimeType != null)) {
    c.executionCtx.waitUntil(
      indexDocumentContent(execQuery, c.env, {
        document_id: documentId,
        storage_bucket: RESOURCE_BUCKET,
        storage_path: path,
        mime_type: mimeType ?? null,
        file_name: path.slice(path.lastIndexOf('/') + 1),
      }).catch((e) => console.error('[docTypes] indexDocumentContent failed:', e instanceof Error ? e.message : e))
    );
  }
  return c.json({ success: true });
});

app.patch('/', requirePermission('resource:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { fromPath, toPath } = body as { fromPath?: string; toPath?: string };
  if (!fromPath || !toPath) return c.json({ success: false, message: 'fromPath and toPath are required' }, 400);

  await execQuery(
    c.env,
    `UPDATE public.document_type SET doc_path = $2, updated_at = now() WHERE doc_path = $1`,
    [fromPath, toPath],
    'docTypes.rename'
  );
  await execQuery(
    c.env,
    `UPDATE public.document
        SET entity_id = $2, storage_path = $2, file_name = $3, updated_at = now()
      WHERE entity_type = 'resource' AND entity_id = $1`,
    [fromPath, toPath, toPath.slice(toPath.lastIndexOf('/') + 1)],
    'docTypes.renameResourceDocument'
  );
  return c.json({ success: true });
});

app.delete('/', requirePermission('resource:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { path } = body as { path?: string };
  if (!path) return c.json({ success: false, message: 'path is required' }, 400);

  await execQuery(c.env, 'DELETE FROM public.document_type WHERE doc_path = $1', [path], 'docTypes.delete');
  await execQuery(
    c.env,
    `DELETE FROM public.document WHERE entity_type = 'resource' AND entity_id = $1`,
    [path],
    'docTypes.deleteResourceDocument'
  );
  return c.json({ success: true });
});

export default app;
