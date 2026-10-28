-- Excel Online editing of xlsx/xls document rows (worker/msGraph.ts).
--
-- One row per document that has ever been opened for edit. The SharePoint
-- copy is keyed by document_id (msGraph.uploadEditCopy's file name), so
-- re-opening the same document must reuse the same driveItem instead of
-- leaking a new one per click — hence UNIQUE (document_id) and an upsert at
-- open time rather than an insert.
--
-- client_state is the shared secret Graph echoes back on every change
-- notification. The webhook is unauthenticated by necessity (Graph has no
-- TBWC token), so this value is the only thing proving a notification is
-- really for this session — it is generated per session and never leaves
-- the Worker except in the subscription itself.

CREATE TABLE IF NOT EXISTS public.office_edit_session (
  office_edit_session_id  bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id             bigint NOT NULL REFERENCES public.document(document_id) ON DELETE CASCADE,
  drive_id                varchar(300) NOT NULL,
  item_id                 varchar(300) NOT NULL,
  subscription_id         varchar(100),
  subscription_expires_at timestamptz,
  client_state            varchar(100) NOT NULL,
  -- Last eTag written back to the bucket. A notification whose current eTag
  -- still matches this is a no-op (Graph re-notifies on metadata-only
  -- touches), which keeps an idle open document from rewriting its own bytes.
  last_etag               text,
  opened_by               uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_edit_session_document_uniq UNIQUE (document_id)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS office_edit_session_subscription_idx
  ON public.office_edit_session (subscription_id);

ALTER TABLE public.office_edit_session OWNER TO postgres;
-- Worker-brokered only (same posture as migration 111/112): no PostgREST
-- path to this table at all, so deny-all RLS with no policy is the whole story.
ALTER TABLE public.office_edit_session ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.office_edit_session TO postgres;
GRANT ALL ON TABLE public.office_edit_session TO service_role;

-- Daily is enough: msGraph.SUBSCRIPTION_MINUTES is ~2.9 days, so a missed
-- tick still leaves nearly two days of margin before a subscription lapses.
INSERT INTO public.scheduled_job (job_name, cron_tier) VALUES
  ('renewOfficeEditSubscriptions', 'daily')
ON CONFLICT (job_name) DO NOTHING;
