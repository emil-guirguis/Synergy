-- Registers rep-docs ("Resources") files into the shared public.document
-- table (entity_type = 'resource', entity_id = the rep-docs object path) so
-- the existing document search/AI tools (search_documents,
-- search_document_contents in aiChat.ts) cover Resources too, instead of a
-- separate search system over the rep-docs bucket.
--
-- entity_id here IS the rep-docs object path (category/subcategory/.../file),
-- not a short record id like every other entity_type — several real paths in
-- the bucket already exceed the varchar(100) width document.sql defines for
-- every other module's use of this column. Widen to match storage_path's
-- cap (varchar(1000), the real ceiling on how long a path can get) rather
-- than truncating or inventing a separate id — TBWC-local divergence from
-- the framework-shared document.sql, same precedent as the doc_type CHECK
-- constraint (migrations 032/046/047).
ALTER TABLE public.document ALTER COLUMN entity_id TYPE varchar(1000);

-- One document row per file, keyed by path — unlike order/quote/invoice
-- attachments (many documents per entity_id), a resource IS its document
-- row, so entity_id must be unique within entity_type = 'resource'. A global
-- unique constraint would break the many-per-entity case other modules rely
-- on, so this is a partial index scoped to just this entity_type.
CREATE UNIQUE INDEX IF NOT EXISTS document_resource_path_idx
  ON public.document (entity_id)
  WHERE entity_type = 'resource';
