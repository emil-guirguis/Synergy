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
import { indexDocumentContent } from '@meterit/framework-backend/api/base/aiSearch';

const RESOURCE_BUCKET = 'rep-docs';

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
