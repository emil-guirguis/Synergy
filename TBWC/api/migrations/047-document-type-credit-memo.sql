-- TBWC migration 047 — adds 'credit_memo' to the doc_type CHECK constraint on
-- public.document, for Document Import's new "cr memo" / "credit memo"
-- filename rule (see classifyDocType() in
-- TBWC/frontend/src/shared/docTypeClassifier.ts).
--
-- The list is owned by the framework (DOC_TYPES in
-- framework/backend/api/base/documents.ts + framework/frontend/documents/types.ts)
-- and mirrored in the canonical DDL (framework/backend/db/document.sql,
-- copied here as 026-documents.sql) — all three were updated with this
-- migration.
--
-- A CHECK constraint can't be extended in place, so drop and re-add. No data
-- moves: every existing value is still legal under the wider list.
-- 'credit_memo' is 11 chars, well under the varchar(20) column limit.
ALTER TABLE public.document
  DROP CONSTRAINT IF EXISTS document_doc_type_check;

ALTER TABLE public.document
  ADD CONSTRAINT document_doc_type_check
    CHECK (doc_type IN ('cutsheet', 'invoice', 'order', 'packing_slip', 'proof_of_delivery',
            'shipping', 'email', 'design', 'load_schedule', 'quote', 'rma', 'shipping_images',
            'change_order', 'waiver', 'panelboard_schedules', 'build_of_materials', 'credit_memo', 'other'));
