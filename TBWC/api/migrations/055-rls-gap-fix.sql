-- TBWC migration 055 — close a public anon-key RLS gap on two tables.
--
-- qbwc_push_queue (023) and rep_doc_type (015) were created with RLS never
-- enabled; 023 additionally GRANTs anon/authenticated explicitly. Found during
-- a post-region-migration audit (2026-09-29) — pre-existing, not caused by the
-- migration, but live: anyone with the public anon key had full CRUD on both
-- via PostgREST. Same bug class as the "13 tables" hole fixed earlier (see
-- framework auth module RLS work).
--
-- Same fix as every other table here (001-005/007, 019, 026): enable RLS with
-- no policies. The Worker connects as `postgres` (table owner), which bypasses
-- RLS entirely, so app functionality is unaffected; PostgREST's anon/
-- authenticated roles get zero rows regardless of the GRANTs already in place.
ALTER TABLE public.qbwc_push_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rep_doc_type    ENABLE ROW LEVEL SECURITY;
