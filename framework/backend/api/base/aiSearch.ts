/**
 * Shared AI-search module — the framework-owned half.
 *
 * Two pieces any app on the framework can reuse:
 *  - a generic substring/exact scorer for the app's own rows (devices,
 *    orders, whatever), so scoring logic isn't reimplemented per app.
 *  - search over the shared public.document table (file_name, mime_type,
 *    doc_type — metadata, always fast) plus an opt-in content sweep that
 *    downloads each document's bytes from Supabase Storage and extracts
 *    text (pdf/docx/xlsx/plain text). The content sweep is slow (one
 *    network fetch + parse per document), so it is a separate function an
 *    app's route exposes as its own endpoint, called only when the user
 *    opts in after seeing the fast metadata results.
 *
 * Deliberately not importing Hono (same duplicate-package hazard as
 * auth.ts/documents.ts): plain functions, each app wraps them in its own
 * Hono route with its own auth — see MeterItPro/api/worker/routes/aiSearch.ts
 * and TBWC/api/worker/routes/aiSearch.ts.
 */
import type { ExecQueryFn } from './crud';

export interface ScoredField<T> {
  key: keyof T;
  /** Score added for a substring match. */
  weight: number;
  /** Score added for an exact (case-insensitive) match; defaults to weight * 2. */
  exactWeight?: number;
}

/** Score one row against a query across the given fields. */
export function scoreEntity<T extends Record<string, any>>(
  row: T,
  query: string,
  fields: ScoredField<T>[]
): number {
  const q = query.trim().toLowerCase();
  let score = 0;
  for (const f of fields) {
    const raw = row[f.key];
    if (raw == null) continue;
    const v = String(raw).toLowerCase();
    if (!v) continue;
    if (v === q) score += f.exactWeight ?? f.weight * 2;
    else if (v.includes(q)) score += f.weight;
  }
  return score;
}

/** Score and sort a set of rows against a query; drops non-matches. */
export function scoreEntities<T extends Record<string, any>>(
  rows: T[],
  query: string,
  fields: ScoredField<T>[]
): { row: T; score: number }[] {
  return rows
    .map((row) => ({ row, score: scoreEntity(row, query, fields) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

export interface DocumentSearchResult {
  documentId: number;
  entityType: string;
  entityId: string;
  fileName: string;
  mimeType: string | null;
  docType: string;
  storageBucket: string | null;
  storagePath: string | null;
  fileSize: number | null;
  score: number;
}

export interface DocumentContentSearchResult extends DocumentSearchResult {
  snippet: string;
}

interface DocumentSearchOptions {
  /** Override only if an app names the table something else. */
  table?: string;
}

const DEFAULT_TABLE = 'document';

/** True for the Postgres "relation does not exist" error — lets an app that
 * hasn't run the document.sql migration yet degrade to "no documents"
 * instead of a 500, without every route needing to know that. */
function isMissingTableError(error: any): boolean {
  return error?.code === '42P01';
}

/**
 * Fast, always-on pass: scores every document's file_name, mime_type and
 * doc_type against the query. Also returns how many documents exist at all,
 * so a caller can offer "search file contents?" even when nothing matched
 * by name.
 */
export async function searchDocumentsMetadata(
  execQuery: ExecQueryFn,
  env: any,
  query: string,
  options?: DocumentSearchOptions
): Promise<{ matches: DocumentSearchResult[]; totalDocuments: number }> {
  const table = options?.table ?? DEFAULT_TABLE;
  let rows: any[];
  try {
    const result = await execQuery(
      env,
      `SELECT document_id, entity_type, entity_id, file_name, mime_type, doc_type, storage_bucket, storage_path, file_size
         FROM public.${table}`,
      [],
      'aiSearch.documents.metadata'
    );
    rows = result.rows;
  } catch (error) {
    if (isMissingTableError(error)) return { matches: [], totalDocuments: 0 };
    throw error;
  }

  const q = query.trim().toLowerCase();
  const matches = rows
    .map((row) => {
      let score = 0;
      const name = String(row.file_name || '').toLowerCase();
      const docType = String(row.doc_type || '').toLowerCase();
      const mime = String(row.mime_type || '').toLowerCase();
      if (name === q) score += 10;
      else if (name.includes(q)) score += 5;
      if (docType === q) score += 8;
      else if (docType.includes(q)) score += 4;
      if (mime.includes(q)) score += 2;
      return { row, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ row, score }) => toResult(row, score));

  return { matches, totalDocuments: rows.length };
}

function toResult(row: any, score: number): DocumentSearchResult {
  return {
    documentId: row.document_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    docType: row.doc_type,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    fileSize: row.file_size,
    score,
  };
}

/** Downloads one object from Supabase Storage using the service-role key
 * (server-side; the browser upload path never touches the Worker). Returns
 * null if the key isn't configured or the fetch fails — callers treat that
 * document as unreadable rather than failing the whole sweep. */
export async function fetchDocumentBytes(
  env: { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string },
  bucket: string,
  path: string
): Promise<ArrayBuffer | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Best-effort text extraction. Returns '' (never throws) for binary types
 * with no known extractor (images, zips, etc.) so a content sweep can skip
 * them silently instead of aborting.
 */
export async function extractDocumentText(
  bytes: ArrayBuffer,
  mimeType: string | null | undefined,
  fileName: string
): Promise<string> {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  try {
    if (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      ['txt', 'csv', 'json', 'md', 'log', 'xml', 'html', 'htm'].includes(ext)
    ) {
      return new TextDecoder('utf-8').decode(bytes);
    }
    if (mime === 'application/pdf' || ext === 'pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return text;
    }
    if (mime.includes('wordprocessingml') || ext === 'docx') {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ arrayBuffer: bytes });
      return value;
    }
    if (mime.includes('spreadsheetml') || ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(bytes, { type: 'array' });
      return wb.SheetNames.map((name) => XLSX.utils.sheet_to_csv(wb.Sheets[name])).join('\n');
    }
  } catch {
    return '';
  }
  return '';
}

const MAX_CONTENT_DOCS = 200;
const MAX_CONTENT_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Slow pass: downloads and text-extracts every document under the size/count
 * caps (newest first) and substring-matches the query against the extracted
 * text — independent of the metadata pass, so it can surface documents whose
 * name didn't match but contents do. Call only after the user opts in.
 */
export async function searchDocumentsContent(
  execQuery: ExecQueryFn,
  env: any,
  query: string,
  options?: DocumentSearchOptions & { maxDocs?: number }
): Promise<{ results: DocumentContentSearchResult[]; scanned: number; truncated: boolean }> {
  const table = options?.table ?? DEFAULT_TABLE;
  const maxDocs = options?.maxDocs ?? MAX_CONTENT_DOCS;

  let rows: any[];
  try {
    const result = await execQuery(
      env,
      `SELECT document_id, entity_type, entity_id, file_name, mime_type, doc_type, storage_bucket, storage_path, file_size
         FROM public.${table}
        WHERE storage_bucket IS NOT NULL AND storage_path IS NOT NULL
          AND (file_size IS NULL OR file_size <= $1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [MAX_CONTENT_FILE_SIZE, maxDocs + 1],
      'aiSearch.documents.content'
    );
    rows = result.rows;
  } catch (error) {
    if (isMissingTableError(error)) return { results: [], scanned: 0, truncated: false };
    throw error;
  }

  const truncated = rows.length > maxDocs;
  const scanRows = rows.slice(0, maxDocs);
  const q = query.trim().toLowerCase();
  const results: DocumentContentSearchResult[] = [];

  for (const row of scanRows) {
    const bytes = await fetchDocumentBytes(env, row.storage_bucket, row.storage_path);
    if (!bytes) continue;
    const text = await extractDocumentText(bytes, row.mime_type, row.file_name);
    if (!text) continue;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) continue;
    const occurrences = lower.split(q).length - 1;
    results.push({
      ...toResult(row, Math.min(occurrences, 5)),
      snippet: text.slice(Math.max(0, idx - 60), idx + q.length + 60).trim(),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return { results, scanned: scanRows.length, truncated };
}
