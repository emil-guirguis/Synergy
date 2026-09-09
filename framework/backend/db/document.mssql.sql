-- MSSQL translation of framework/backend/db/document.sql — reference only, not
-- applied by any app today (both apps run Postgres/Supabase). Kept in sync by
-- hand so a SQL Server port has a starting point.
--
-- Differences that matter beyond types: SQL Server has no `RETURNING`, so the
-- INSERT/UPDATE/DELETE statements in api/base/documents.ts need `OUTPUT
-- INSERTED.*` / `OUTPUT DELETED.*`, and $1-style placeholders become @p1.
-- If `content` is ever used, the driver parameter MUST be declared
-- VarBinary(MAX) — the default inferred length silently truncates at 8000 bytes.

IF OBJECT_ID('dbo.document', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.document (
    document_id    BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT document_pkey PRIMARY KEY,
    entity_type    NVARCHAR(100) NOT NULL,
    entity_id      NVARCHAR(100) NOT NULL,
    description    NVARCHAR(MAX) NULL,
    doc_type       NVARCHAR(30) NOT NULL CONSTRAINT document_doc_type_default DEFAULT 'other',
    file_name      NVARCHAR(400) NOT NULL,
    mime_type      NVARCHAR(200) NULL,
    file_size      BIGINT NULL,
    storage_bucket NVARCHAR(100) NULL,
    storage_path   NVARCHAR(1000) NULL,
    content        VARBINARY(MAX) NULL,
    created_by     UNIQUEIDENTIFIER NULL,
    created_at     DATETIME2 NOT NULL CONSTRAINT document_created_at_default DEFAULT SYSUTCDATETIME(),
    updated_at     DATETIME2 NOT NULL CONSTRAINT document_updated_at_default DEFAULT SYSUTCDATETIME(),
    CONSTRAINT document_doc_type_check
      CHECK (doc_type IN ('cutsheet', 'invoice', 'order', 'design', 'other')),
    CONSTRAINT document_payload_check
      CHECK (storage_path IS NOT NULL OR content IS NOT NULL)
  );

  CREATE INDEX document_entity_idx ON dbo.document (entity_type, entity_id);
END
