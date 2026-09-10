/**
 * Shared per-record documents module — the framework-owned half.
 *
 * Any module in any app on the framework can hang files off one of its rows:
 * a document row points at its owner by (entity_type, entity_id) with no FK, so
 * adding documents to a new module is a route mount + a UI tab, never a migration.
 * Table DDL: framework/backend/db/document.sql (copied into each app's migrations).
 *
 * Storage split — metadata here, bytes in an object store (Supabase Storage).
 * The browser uploads straight to the bucket with the signed-in user's token and
 * then POSTs the metadata here, so file bytes never pass through the Worker (a
 * Worker has ~128MB of RAM and would otherwise base64 every upload over the pg
 * wire). `content bytea` is reserved for a DB-blob backend; nothing writes it today.
 *
 * Deliberately not importing Hono (same duplicate-package hazard auth.ts documents):
 * these are plain functions, and each app wraps them in its own Hono route with its
 * own auth middleware — see TBWC/api/worker/routes/documents.ts.
 */
import type { ExecQueryFn } from './crud';

/** Line-item classification shown as a dropdown in the documents grid. */
export const DOC_TYPES = [
  'cutsheet',
  'invoice',
  'order',
  'packing_slip',
  'proof_of_delivery',
  'shipping',
  'email',
  'design',
  'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DEFAULT_DOC_TYPE: DocType = 'other';

export function isDocType(v: unknown): v is DocType {
  return typeof v === 'string' && (DOC_TYPES as readonly string[]).includes(v);
}

export interface DocumentRow {
  document_id: number;
  entity_type: string;
  entity_id: string;
  description: string | null;
  doc_type: DocType;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
  storage_bucket: string | null;
  storage_path: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDocumentInput {
  entityType: string;
  entityId: string;
  fileName: string;
  storageBucket: string;
  storagePath: string;
  description?: string | null;
  docType?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  createdBy?: string | null;
}

export interface UpdateDocumentInput {
  description?: string | null;
  docType?: string | null;
}

export interface DocumentsOptions {
  /** Override only if an app names the table something else. */
  table?: string;
  /** Reject uploads larger than this (bytes). Default 25MB. */
  maxFileSize?: number;
}

const DEFAULT_TABLE = 'document';
export const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Mirrors the varchar(n) widths in db/document.sql — checked here so an
// over-long value comes back as a 400 with the offending field named, instead
// of a raw "value too long for type character varying" 500 from the driver.
const MAX_LENGTHS: Record<string, number> = {
  entityType: 50,
  entityId: 100,
  description: 2000,
  docType: 20,
  fileName: 400,
  mimeType: 255,
  storageBucket: 100,
  storagePath: 1000,
};

function assertLengths(input: Record<string, any>): void {
  for (const [key, max] of Object.entries(MAX_LENGTHS)) {
    const value = input[key];
    if (typeof value === 'string' && value.length > max) {
      throw new DocumentValidationError(`${key} exceeds ${max} characters`);
    }
  }
}

/** Thrown for bad client input; app routes map this to a 400. */
export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

const COLUMNS = `document_id, entity_type, entity_id, description, doc_type, file_name,
                 mime_type, file_size, storage_bucket, storage_path, created_by, created_at, updated_at`;

function tableOf(options?: DocumentsOptions): string {
  const table = options?.table ?? DEFAULT_TABLE;
  if (!SAFE_IDENT.test(table)) throw new Error(`Invalid documents table: ${table}`);
  return table;
}

/**
 * Object key prefix a record's files are stored under. Both halves compute this
 * the same way — the frontend to place the upload, the backend to verify that a
 * path a client claims really belongs to the record it names (assertPathMatches).
 */
export function storagePrefix(entityType: string, entityId: string): string {
  return `${entityType}/${entityId}/`;
}

function assertPathMatches(input: CreateDocumentInput): void {
  const prefix = storagePrefix(input.entityType, input.entityId);
  if (!input.storagePath.startsWith(prefix)) {
    // Without this, a client could attach an object uploaded under some other
    // record's prefix (or a path it merely guessed) to this record.
    throw new DocumentValidationError('storagePath must live under the record prefix');
  }
  if (input.storagePath.includes('..')) {
    throw new DocumentValidationError('storagePath may not contain ".."');
  }
}

/** All documents attached to one record, newest first. Metadata only — never bytes. */
export async function listDocuments(
  execQuery: ExecQueryFn,
  env: any,
  entityType: string,
  entityId: string,
  options?: DocumentsOptions
): Promise<DocumentRow[]> {
  if (!entityType || !entityId) {
    throw new DocumentValidationError('entity_type and entity_id are required');
  }
  const result = await execQuery(
    env,
    `SELECT ${COLUMNS} FROM public.${tableOf(options)}
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY created_at DESC, document_id DESC`,
    [entityType, String(entityId)],
    'documents.list'
  );
  return result.rows as DocumentRow[];
}

export async function getDocument(
  execQuery: ExecQueryFn,
  env: any,
  documentId: string | number,
  options?: DocumentsOptions
): Promise<DocumentRow | null> {
  const result = await execQuery(
    env,
    `SELECT ${COLUMNS} FROM public.${tableOf(options)} WHERE document_id = $1`,
    [documentId],
    'documents.get'
  );
  return (result.rows[0] as DocumentRow) ?? null;
}

export async function createDocument(
  execQuery: ExecQueryFn,
  env: any,
  input: CreateDocumentInput,
  options?: DocumentsOptions
): Promise<DocumentRow> {
  const required: (keyof CreateDocumentInput)[] = ['entityType', 'entityId', 'fileName', 'storageBucket', 'storagePath'];
  for (const key of required) {
    if (!input[key]) throw new DocumentValidationError(`${key} is required`);
  }
  if (input.docType != null && !isDocType(input.docType)) {
    throw new DocumentValidationError(`doc_type must be one of: ${DOC_TYPES.join(', ')}`);
  }
  const maxSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  if (input.fileSize != null && input.fileSize > maxSize) {
    throw new DocumentValidationError(`File exceeds the ${Math.round(maxSize / 1024 / 1024)}MB limit`);
  }
  assertLengths(input as Record<string, any>);
  assertPathMatches(input);

  const result = await execQuery(
    env,
    `INSERT INTO public.${tableOf(options)}
       (entity_type, entity_id, description, doc_type, file_name, mime_type, file_size,
        storage_bucket, storage_path, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${COLUMNS}`,
    [
      input.entityType,
      String(input.entityId),
      input.description ?? null,
      isDocType(input.docType) ? input.docType : DEFAULT_DOC_TYPE,
      input.fileName,
      input.mimeType ?? null,
      input.fileSize ?? null,
      input.storageBucket,
      input.storagePath,
      input.createdBy ?? null,
    ],
    'documents.create'
  );
  return result.rows[0] as DocumentRow;
}

/** Description / type only — the file itself is replaced by deleting and re-uploading. */
export async function updateDocument(
  execQuery: ExecQueryFn,
  env: any,
  documentId: string | number,
  patch: UpdateDocumentInput,
  options?: DocumentsOptions
): Promise<DocumentRow | null> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.description !== undefined) {
    params.push(patch.description);
    sets.push(`description = $${params.length}`);
  }
  if (patch.docType !== undefined) {
    if (!isDocType(patch.docType)) {
      throw new DocumentValidationError(`doc_type must be one of: ${DOC_TYPES.join(', ')}`);
    }
    params.push(patch.docType);
    sets.push(`doc_type = $${params.length}`);
  }
  if (sets.length === 0) throw new DocumentValidationError('Nothing to update');
  assertLengths(patch as Record<string, any>);

  params.push(documentId);
  const result = await execQuery(
    env,
    `UPDATE public.${tableOf(options)}
        SET ${sets.join(', ')}, updated_at = now()
      WHERE document_id = $${params.length}
      RETURNING ${COLUMNS}`,
    params,
    'documents.update'
  );
  return (result.rows[0] as DocumentRow) ?? null;
}

/**
 * Deletes the metadata row and returns it, so the caller knows which object to
 * drop from the bucket. Row goes first: a failed object delete leaves an
 * unreferenced file (harmless, sweepable), while the reverse order would leave a
 * row pointing at nothing — a broken link in the UI.
 */
export async function deleteDocument(
  execQuery: ExecQueryFn,
  env: any,
  documentId: string | number,
  options?: DocumentsOptions
): Promise<DocumentRow | null> {
  const result = await execQuery(
    env,
    `DELETE FROM public.${tableOf(options)} WHERE document_id = $1 RETURNING ${COLUMNS}`,
    [documentId],
    'documents.delete'
  );
  return (result.rows[0] as DocumentRow) ?? null;
}
