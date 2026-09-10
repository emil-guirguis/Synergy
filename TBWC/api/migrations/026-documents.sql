-- TBWC migration 026 — per-record documents.
-- COPY of framework/backend/db/document.sql (canonical). Edit the framework file
-- first, then re-copy here; the two must stay identical.
-- Adds below the table: the private Storage bucket the files live in + its RLS
-- policies (TBWC-specific, not part of the framework DDL).

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
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_doc_type_check
    -- Keep in sync with DOC_TYPES in framework/backend/api/base/documents.ts and
    -- framework/frontend/documents/types.ts. Adding a value needs a migration that
    -- drops and re-adds this constraint (TBWC: migrations/032-document-types.sql).
    CHECK (doc_type IN ('cutsheet', 'invoice', 'order', 'packing_slip', 'proof_of_delivery',
            'shipping', 'email', 'design', 'other')),
  -- A row with neither a storage object nor inline bytes is an orphan record.
  CONSTRAINT document_payload_check
    CHECK (storage_path IS NOT NULL OR content IS NOT NULL)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS document_entity_idx
  ON public.document (entity_type, entity_id);

ALTER TABLE public.document OWNER TO postgres;
-- Worker connects as postgres (table owner, bypasses RLS). RLS on + no policies
-- means PostgREST roles get nothing: reads go through the app's own API, which
-- applies the module's auth. Mirrors 019-company-settings.sql.
ALTER TABLE public.document ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.document TO postgres;
GRANT ALL ON TABLE public.document TO service_role;


-- ===== Storage bucket (TBWC-specific) =====
-- Files themselves live in a private bucket; `document` rows hold the path.
-- Separate from the Rep Portal's `rep-docs` bucket: different audience, different
-- policies, and record attachments are keyed by <entity_type>/<entity_id>/ prefix.
INSERT INTO storage.buckets (id, name, public)
SELECT 'record-docs', 'record-docs', false
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'record-docs');

-- The browser uploads/reads with the signed-in user's own token, so the bucket
-- needs policies for `authenticated`. Module-level authorization (who may see
-- orders at all) is enforced by the Worker API in front of the metadata rows;
-- these policies only gate raw object access to signed-in users.
DROP POLICY IF EXISTS "record-docs authenticated read" ON storage.objects;
CREATE POLICY "record-docs authenticated read" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'record-docs');

DROP POLICY IF EXISTS "record-docs authenticated insert" ON storage.objects;
CREATE POLICY "record-docs authenticated insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'record-docs');

DROP POLICY IF EXISTS "record-docs authenticated update" ON storage.objects;
CREATE POLICY "record-docs authenticated update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'record-docs') WITH CHECK (bucket_id = 'record-docs');

DROP POLICY IF EXISTS "record-docs authenticated delete" ON storage.objects;
CREATE POLICY "record-docs authenticated delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'record-docs');
