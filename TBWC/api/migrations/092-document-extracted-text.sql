-- Full-text index for document content search. Replaces search_document_contents'
-- old behavior (download + parse every file, up to 200, on every single query —
-- aiSearch.ts's searchDocumentsContent before this migration) with a normal
-- indexed Postgres query: text is extracted once (at upload time, or by the
-- backfill cron/script) and stored here, same idea as SQL Server Full-Text
-- Search (GIN index on a tsvector instead of CONTAINS()/FREETEXT() scanning).
--
-- NULL extracted_text = not yet indexed; '' = indexed, no extractable text.
-- search_vector is kept in sync by application code (indexDocumentContent in
-- framework/backend/api/base/aiSearch.ts) rather than a GENERATED column,
-- because to_tsvector() is STABLE not IMMUTABLE in Postgres.
ALTER TABLE public.document ADD COLUMN IF NOT EXISTS extracted_text text;
ALTER TABLE public.document ADD COLUMN IF NOT EXISTS extracted_at timestamptz;
ALTER TABLE public.document ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS document_search_vector_idx
  ON public.document USING gin (search_vector);
