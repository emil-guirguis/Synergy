-- ===== Canonical `document` table (framework-owned) =====
-- Generic per-record attachments: any module in any app on the framework can
-- hang documents off one of its rows by (entity_type, entity_id) — no FK, so a
-- new module needs no migration, just a new entity_type string.
--
-- Bytes live in an object store (Supabase Storage bucket, `storage_bucket` +
-- `storage_path`); this table holds metadata only. `content bytea` exists but
-- stays NULL — it is the escape hatch for a DB-blob store (see
-- framework/backend/api/base/documents.ts's DocumentStore split), so switching
-- storage later is a backfill, not a schema break.
--
-- Consuming apps copy this file into their own migrations dir verbatim (TBWC:
-- migrations/026-documents.sql). Edit here first, then re-copy.
-- Naming convention: {tablename}_id primary key.
-- MSSQL translation of this file: framework/backend/db/document.mssql.sql

-- Column widths: in Postgres varchar(n) and text share identical storage (both
-- varlena + TOAST) — the lengths below are validation, not a size optimization,
-- so a client can't push a megabyte into file_name. `description` is the only
-- free-text field and gets the loosest cap. They also translate straight across
-- to sized NVARCHAR on SQL Server, where NVARCHAR(MAX) really is a different
-- (off-row, non-indexable) type.

CREATE TABLE IF NOT EXISTS public.document (
  document_id    bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Owning record. entity_id is a string, not bigint: PK types differ per module
  -- (bigint identity, uuid, QB ListID strings), and this table joins to none of them.
  entity_type    varchar(50) NOT NULL,
  entity_id      varchar(100) NOT NULL,
  description    varchar(2000),
  doc_type       varchar(20) NOT NULL DEFAULT 'other',
  file_name      varchar(400) NOT NULL,
  mime_type      varchar(255),
  file_size      bigint,
  -- Object-store location (current storage backend).
  storage_bucket varchar(100),
  storage_path   varchar(1000),
  -- DB-blob backend (unused today; see header).
  content        bytea,
  -- Text extracted from the file (pdf/docx/xlsx/plain text — see
  -- api/base/aiSearch.ts's extractDocumentText), indexed below for fast full-
  -- text search instead of downloading+parsing every file on each query (the
  -- same idea as SQL Server Full-Text Search: a maintained index, not a live
  -- CONTAINS()-style scan). NULL = not yet indexed (brand new upload, or
  -- pending the next backfill sweep); '' = indexed and genuinely has no
  -- extractable text (e.g. an image-only PDF, or an unsupported binary type).
  extracted_text text,
  extracted_at   timestamptz,
  -- Maintained alongside extracted_text by the same write (indexDocumentContent
  -- in api/base/aiSearch.ts) rather than a GENERATED column, because
  -- to_tsvector() is STABLE, not IMMUTABLE, in Postgres — generated-column
  -- expressions require IMMUTABLE.
  search_vector  tsvector,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_doc_type_check
    -- Keep in sync with DOC_TYPES in framework/backend/api/base/documents.ts and
    -- framework/frontend/documents/types.ts. Adding a value needs a migration that
    -- drops and re-adds this constraint (TBWC: migrations/032-document-types.sql,
    -- 046-document-types-2.sql, 047-document-type-credit-memo.sql).
    CHECK (doc_type IN ('cutsheet', 'invoice', 'order', 'packing_slip', 'proof_of_delivery',
            'shipping', 'email', 'design', 'load_schedule', 'quote', 'rma', 'shipping_images',
            'change_order', 'waiver', 'panelboard_schedules', 'build_of_materials', 'credit_memo', 'other')),
  -- A row with neither a storage object nor inline bytes is an orphan record.
  CONSTRAINT document_payload_check
    CHECK (storage_path IS NOT NULL OR content IS NOT NULL)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS document_entity_idx
  ON public.document (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS document_search_vector_idx
  ON public.document USING gin (search_vector);

ALTER TABLE public.document OWNER TO postgres;
-- Worker connects as postgres (table owner, bypasses RLS). RLS on + no policies
-- means PostgREST roles get nothing: reads go through the app's own API, which
-- applies the module's auth. Mirrors 019-company-settings.sql.
ALTER TABLE public.document ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.document TO postgres;
GRANT ALL ON TABLE public.document TO service_role;
