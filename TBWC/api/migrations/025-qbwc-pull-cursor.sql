-- Durable "confirmed fully synced through" watermark, separate from a staging
-- table's own MAX(time_modified). Fixes the Invoice pull silently skipping a
-- historical backlog forever: sinceModified() derives its filter from
-- qb_invoice.time_modified, but if a Start/Continue iterator sequence never
-- finishes draining (QB reports no iteratorRemainingCount when it should, or a
-- session ends mid-page), that MAX() advances past records QB hasn't actually
-- returned yet -- they can never be fetched again since the filter is now past
-- their (older) TimeModified. confirmed_through only advances when a pull's
-- iterator is confirmed fully drained; while drain_pending is true, buildRequest
-- must fall back to confirmed_through instead of trusting the live table.
-- Follows naming convention: {tablename}_id primary keys.
CREATE TABLE IF NOT EXISTS public.qbwc_pull_cursor (
  qbwc_pull_cursor_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 ),
  object_type character varying(40) NOT NULL,
  confirmed_through timestamp without time zone,   -- null = no confirmed-complete pull yet (full pull needed)
  drain_pending boolean NOT NULL DEFAULT false,     -- true = last iterator sequence didn't confirm fully drained
  updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT qbwc_pull_cursor_pkey PRIMARY KEY (qbwc_pull_cursor_id),
  CONSTRAINT qbwc_pull_cursor_object_key UNIQUE (object_type)
) TABLESPACE pg_default;

ALTER TABLE IF EXISTS public.qbwc_pull_cursor OWNER to postgres;
ALTER TABLE public.qbwc_pull_cursor ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.qbwc_pull_cursor TO postgres;
GRANT ALL ON TABLE public.qbwc_pull_cursor TO service_role;
