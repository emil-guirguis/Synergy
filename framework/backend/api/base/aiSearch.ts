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

export interface DocumentCandidate {
  documentId: number;
  entityType: string;
  fileName: string;
  docType: string;
}

export interface DocumentContentSearchResult extends DocumentSearchResult {
  snippet: string;
}

interface DocumentSearchOptions {
  /** Override only if an app names the table something else. */
  table?: string;
  /** Restrict to these entity_type values (e.g. an app scoping the search tool
   *  to only the entity types the caller's permissions actually cover — see
   *  TBWC's aiChat.ts). Omit for no filter (every entity_type, the original
   *  behavior); an empty array matches nothing rather than everything, so a
   *  caller computing "entity types I'm allowed to see" as [] fails closed. */
  entityTypes?: string[];
}

const DEFAULT_TABLE = 'document';

/** True for the Postgres "relation does not exist" error — lets an app that
 * hasn't run the document.sql migration yet degrade to "no documents"
 * instead of a 500, without every route needing to know that. */
function isMissingTableError(error: any): boolean {
  return error?.code === '42P01';
}

/** Cap on the fallback candidate list handed to the model when nothing
 *  scores — keeps the tool-result payload (and token cost) bounded even on
 *  a large document table. */
const MAX_CANDIDATES = 300;

/**
 * Fast, always-on pass: scores every document's file_name, mime_type and
 * doc_type against the query. Also returns how many documents exist at all,
 * so a caller can offer "search file contents?" even when nothing matched
 * by name.
 *
 * Word-level scoring (see queryWords below) still misses a genuine match
 * phrased with none of the query's words in common — a scorer can't bridge
 * that, only the model's own judgment can. So when nothing scores at all,
 * this also returns `candidates`: every document name/type the model can
 * read and pick from itself, rather than the caller reporting "not found"
 * on an empty array the model never got to reason over.
 */
export async function searchDocumentsMetadata(
  execQuery: ExecQueryFn,
  env: any,
  query: string,
  options?: DocumentSearchOptions
): Promise<{ matches: DocumentSearchResult[]; totalDocuments: number; candidates?: DocumentCandidate[] }> {
  const table = options?.table ?? DEFAULT_TABLE;
  if (options?.entityTypes && options.entityTypes.length === 0) return { matches: [], totalDocuments: 0 };
  let rows: any[];
  try {
    const result = await execQuery(
      env,
      `SELECT document_id, entity_type, entity_id, file_name, mime_type, doc_type, storage_bucket, storage_path, file_size
         FROM public.${table}
        ${options?.entityTypes ? 'WHERE entity_type = ANY($1)' : ''}`,
      options?.entityTypes ? [options.entityTypes] : [],
      'aiSearch.documents.metadata'
    );
    rows = result.rows;
  } catch (error) {
    if (isMissingTableError(error)) return { matches: [], totalDocuments: 0 };
    throw error;
  }

  const q = query.trim().toLowerCase();
  const words = queryWords(q);
  const matches = rows
    .map((row) => {
      let score = 0;
      const name = String(row.file_name || '').toLowerCase();
      const docType = String(row.doc_type || '').toLowerCase();
      const mime = String(row.mime_type || '').toLowerCase();
      if (name === q) score += 10;
      else if (q && name.includes(q)) score += 5;
      if (docType === q) score += 8;
      else if (q && docType.includes(q)) score += 4;
      if (q && mime.includes(q)) score += 2;
      // Whole-query substring match misses a real file whose name has extra
      // words threaded through it ("Dent PowerScout Manual" vs "Dent
      // PowerScout Meters Owners Manual.pdf") — score per word too, same fix
      // as search_users' "Jenifer"/"Jennifer" gap (see userSearch.ts).
      for (const w of words) {
        if (name.includes(w)) score += 2;
        if (docType.includes(w)) score += 1;
      }
      return { row, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ row, score }) => toResult(row, score));

  if (matches.length > 0 || rows.length === 0) {
    return { matches, totalDocuments: rows.length };
  }
  const candidates: DocumentCandidate[] = rows.slice(0, MAX_CANDIDATES).map((row) => ({
    documentId: row.document_id,
    entityType: row.entity_type,
    fileName: row.file_name,
    docType: row.doc_type,
  }));
  return { matches, totalDocuments: rows.length, candidates };
}

/** Below this, a word is noise for matching purposes ("a", "of"). */
const MIN_WORD_LENGTH = 2;

function queryWords(q: string): string[] {
  // Split on whitespace only — splitting on comma too would break a
  // thousands-grouped number like "127,850.00" into "127" + "850.00",
  // neither of which matches the single '127850.00' lexeme Postgres's own
  // text search parser produces for that number in to_tsvector/to_tsquery.
  return [...new Set(q.split(/\s+/).filter((w) => w.length >= MIN_WORD_LENGTH))];
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

/** A raw data-dump spreadsheet (every row/column CSV'd together) can run to
 *  tens of MB of "text" — two real uploads did, and the resulting
 *  to_tsvector() computation exceeded the Supabase pooler's statement
 *  timeout. That's also just not useful full-text-search material (nobody
 *  asks a chat question whose answer is "row 48,000 of a parts count"), so
 *  truncating well before it gets painful is strictly better than either
 *  failing the write or paying to index content nobody will search for. */
const MAX_EXTRACTED_TEXT_LENGTH = 500_000;

/** Postgres text/varchar columns reject a literal NUL byte outright (a valid
 *  UTF-8 string can still contain one) — a malformed PDF's embedded fonts
 *  can emit one, and that one byte otherwise crashes the whole UPDATE (and,
 *  in a batch loop, everything queued after it). Other C0 control characters
 *  are stripped too: Postgres accepts them, but they're noise for search.
 *  Written as a charCode scan rather than a regex char class so there is no
 *  ambiguity about which raw bytes end up in this source file. */
function sanitizeExtractedText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length && out.length < MAX_EXTRACTED_TEXT_LENGTH; i++) {
    const code = text.charCodeAt(i);
    const isTabLfCr = code === 9 || code === 10 || code === 13;
    if (isTabLfCr || code >= 32) out += text[i];
  }
  return out;
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
      return sanitizeExtractedText(new TextDecoder('utf-8').decode(bytes));
    }
    if (mime === 'application/pdf' || ext === 'pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return sanitizeExtractedText(text);
    }
    if (mime.includes('wordprocessingml') || ext === 'docx') {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ arrayBuffer: bytes });
      return sanitizeExtractedText(value);
    }
    if (mime.includes('spreadsheetml') || ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(bytes, { type: 'array' });
      return sanitizeExtractedText(wb.SheetNames.map((name) => XLSX.utils.sheet_to_csv(wb.Sheets[name])).join('\n'));
    }
  } catch {
    return '';
  }
  return '';
}

const MAX_CONTENT_FILE_SIZE = 20 * 1024 * 1024;
/** Default cap on how many un-indexed documents one backfill call fetches
 *  — run repeatedly (cron every 15 min, or the one-time backfill script)
 *  rather than raised. Just a row cap on the SELECT; see DEFAULT_MAX_MILLIS
 *  for what actually bounds CPU use, since 25 tiny .txt files and 25 big
 *  PDFs cost wildly different amounts of parsing time for the same count. */
const DEFAULT_BACKFILL_BATCH = 25;
/** Default wall-clock budget for one backfillDocumentIndex call. This job
 *  shares a single cron invocation's CPU budget with 3 other jobs (see each
 *  app's Worker scheduled() handler) — a batch of large PDF/docx/xlsx files
 *  tripped the invocation's CPU limit before it got through all 25, which
 *  silently killed whichever job ran after it that tick. Bailing out early
 *  on elapsed time (not rows processed) means this job's cost no longer
 *  depends on what happens to be in the batch; whatever it doesn't reach
 *  stays NULL and is picked up next tick. */
const DEFAULT_MAX_MILLIS = 5000;

export interface DocumentIndexTarget {
  document_id: number;
  storage_bucket: string | null;
  storage_path: string | null;
  mime_type: string | null;
  file_name: string;
}

/**
 * Downloads one document, extracts its text, and stores it (plus the derived
 * tsvector) on the row — the write side of full-text search. Called right
 * after upload (routes/documents.ts, routes/docTypes.ts) so a new file is
 * searchable within seconds, and by backfillDocumentIndex for anything that
 * missed that (extraction failure, or uploaded before this existed).
 *
 * A failed *fetch* (bytes === null — network blip, object briefly missing)
 * leaves extracted_text NULL so the next backfill sweep retries it. A
 * successful fetch that yields no text (extractDocumentText already handles
 * unsupported/binary types) is still a real result — stored as '' so it's
 * not retried forever.
 */
export async function indexDocumentContent(
  execQuery: ExecQueryFn,
  env: any,
  doc: DocumentIndexTarget,
  options?: { table?: string }
): Promise<boolean> {
  if (!doc.storage_bucket || !doc.storage_path) return false;
  const bytes = await fetchDocumentBytes(env, doc.storage_bucket, doc.storage_path);
  if (!bytes) return false;
  const text = await extractDocumentText(bytes, doc.mime_type, doc.file_name);
  const table = options?.table ?? DEFAULT_TABLE;
  await execQuery(
    env,
    `UPDATE public.${table}
        SET extracted_text = $2,
            search_vector = to_tsvector('english', $2),
            extracted_at = now()
      WHERE document_id = $1`,
    [doc.document_id, text],
    'aiSearch.documents.index'
  );
  return true;
}

/**
 * Safety net for indexDocumentContent: indexes up to `limit` documents that
 * still have no extracted_text (upload-time indexing failed, or predates
 * it), oldest first. Meant to run on a schedule (see each app's Worker
 * `scheduled()`) — bounded per call so a large backlog is worked off over
 * several runs instead of one long one.
 *
 * One document's indexDocumentContent failure (bad bytes, an extraction
 * error that somehow escaped its own try/catch, a transient DB error) must
 * not abort the rest of the batch — so each row is isolated in its own
 * try/catch rather than letting the loop's single await propagate.
 */
export async function backfillDocumentIndex(
  execQuery: ExecQueryFn,
  env: any,
  options?: { table?: string; limit?: number; maxMillis?: number }
): Promise<{ indexed: number; attempted: number }> {
  const table = options?.table ?? DEFAULT_TABLE;
  const limit = options?.limit ?? DEFAULT_BACKFILL_BATCH;
  const deadline = Date.now() + (options?.maxMillis ?? DEFAULT_MAX_MILLIS);
  let rows: any[];
  try {
    const result = await execQuery(
      env,
      `SELECT document_id, storage_bucket, storage_path, mime_type, file_name
         FROM public.${table}
        WHERE extracted_text IS NULL
          AND storage_bucket IS NOT NULL AND storage_path IS NOT NULL
          AND (file_size IS NULL OR file_size <= $1)
        ORDER BY created_at ASC
        LIMIT $2`,
      [MAX_CONTENT_FILE_SIZE, limit],
      'aiSearch.documents.backfill'
    );
    rows = result.rows;
  } catch (error) {
    if (isMissingTableError(error)) return { indexed: 0, attempted: 0 };
    throw error;
  }

  let indexed = 0;
  let attempted = 0;
  for (const row of rows) {
    // Time-boxed, not just row-capped: a handful of large PDF/docx/xlsx files
    // can cost far more CPU than `limit` tiny .txt files, so bailing out on
    // elapsed time (rather than rows processed) keeps this call's cost
    // predictable regardless of what's actually in the batch. Anything left
    // stays extracted_text IS NULL and is picked up by the next scheduled run.
    if (Date.now() >= deadline) break;
    attempted++;
    try {
      if (await indexDocumentContent(execQuery, env, row, options)) indexed++;
    } catch (error) {
      console.error(`[backfillDocumentIndex] document_id ${row.document_id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return { indexed, attempted };
}

/** Builds an OR'd tsquery string ("word1 | word2 | word3") from a free-text
 *  query. websearch_to_tsquery ANDs bare words together by default — a chat
 *  question like "service agreement termination policy" would then require
 *  the document to literally contain "policy" too, even though the user's
 *  own wording (not the document's) supplied that word. OR + ts_rank lets a
 *  document matching some words outrank one matching none, same spirit as a
 *  real search engine, without demanding every word be present. Each word is
 *  stripped down so it can't inject a tsquery operator (&|!<>():'" etc.) —
 *  but '.' and ',' survive so a number like "127,850.00" reaches to_tsquery
 *  intact and Postgres's own parser normalizes it to the same '127850.00'
 *  lexeme already stored in search_vector; otherwise it'd never match. */
function orTsQuery(q: string): string | null {
  const words = queryWords(q.trim().toLowerCase())
    .map((w) => w.replace(/[^a-z0-9.,]/g, '').replace(/^[.,]+|[.,]+$/g, ''))
    .filter(Boolean);
  return words.length ? words.join(' | ') : null;
}

/**
 * Full-text search over indexed document content — a normal GIN-indexed
 * query (see migration 092/document.sql's search_vector column) instead of
 * downloading and parsing files per request. Covers only documents that have
 * been indexed (extracted_text IS NOT NULL and non-empty); anything still
 * pending shows up once indexDocumentContent/backfillDocumentIndex catches
 * up to it.
 */
export async function searchDocumentsContent(
  execQuery: ExecQueryFn,
  env: any,
  query: string,
  options?: DocumentSearchOptions & { limit?: number }
): Promise<{ results: DocumentContentSearchResult[]; scanned: number; truncated: boolean }> {
  const table = options?.table ?? DEFAULT_TABLE;
  if (options?.entityTypes && options.entityTypes.length === 0) return { results: [], scanned: 0, truncated: false };
  const tsQuery = orTsQuery(query);
  if (!tsQuery) return { results: [], scanned: 0, truncated: false };
  const limit = options?.limit ?? 50;

  const params: any[] = [tsQuery];
  let sql = `
    SELECT document_id, entity_type, entity_id, file_name, mime_type, doc_type, storage_bucket, storage_path, file_size,
           ts_rank(search_vector, to_tsquery('english', $1)) AS rank,
           ts_headline('english', extracted_text, to_tsquery('english', $1),
             'MaxFragments=1, MaxWords=35, MinWords=15, ShortWord=3') AS snippet
      FROM public.${table}
     WHERE search_vector @@ to_tsquery('english', $1)`;
  if (options?.entityTypes) {
    params.push(options.entityTypes);
    sql += ` AND entity_type = ANY($${params.length})`;
  }
  params.push(limit);
  sql += ` ORDER BY rank DESC LIMIT $${params.length}`;

  let rows: any[];
  try {
    const result = await execQuery(env, sql, params, 'aiSearch.documents.content');
    rows = result.rows;
  } catch (error) {
    if (isMissingTableError(error)) return { results: [], scanned: 0, truncated: false };
    throw error;
  }

  const results: DocumentContentSearchResult[] = rows.map((row) => ({
    ...toResult(row, Math.min(Number(row.rank) || 0, 1)),
    snippet: String(row.snippet ?? '').replace(/\s+/g, ' ').trim(),
  }));

  // Every indexed document is always considered (no cap-induced gap like the
  // old per-request download sweep had) — scanned/truncated kept for
  // interface stability with existing callers (TBWC's routes/aiSearch.ts).
  return { results, scanned: results.length, truncated: false };
}
