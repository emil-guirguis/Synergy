-- backfillDocumentIndex (aiSearch.ts) always picks the oldest extracted_text
-- IS NULL row first. A row whose extraction trips the Worker's CPU limit
-- kills the whole isolate (uncatchable — not a JS exception the per-row
-- try/catch can see), so extracted_text never gets set and the same row is
-- picked again next tick, forever. One 19.85MB PDF (document_id 10767) did
-- exactly this for 11 straight hourly ticks on 2026-10-21.
--
-- index_attempts is incremented BEFORE the risky extract call (so the write
-- survives even if the isolate dies right after), and backfillDocumentIndex
-- excludes rows at/above a small cap — see MAX_INDEX_ATTEMPTS in aiSearch.ts.

ALTER TABLE public.document ADD COLUMN IF NOT EXISTS index_attempts int NOT NULL DEFAULT 0;
