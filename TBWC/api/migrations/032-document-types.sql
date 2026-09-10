-- TBWC migration 032 — four more document types.
--
-- Adds packing_slip, proof_of_delivery, shipping and email to the doc_type
-- CHECK constraint on public.document. The list is owned by the framework
-- (DOC_TYPES in framework/backend/api/base/documents.ts +
-- framework/frontend/documents/types.ts) and mirrored in the canonical DDL
-- (framework/backend/db/document.sql, copied here as 026-documents.sql) —
-- all four were updated with this migration.
--
-- A CHECK constraint can't be extended in place, so drop and re-add. No data
-- moves: every existing value is still legal under the wider list.
-- 'proof_of_delivery' is 17 chars, inside the varchar(20) column.
ALTER TABLE public.document
  DROP CONSTRAINT IF EXISTS document_doc_type_check;

ALTER TABLE public.document
  ADD CONSTRAINT document_doc_type_check
    CHECK (doc_type IN ('cutsheet', 'invoice', 'order', 'packing_slip', 'proof_of_delivery',
            'shipping', 'email', 'design', 'other'));
