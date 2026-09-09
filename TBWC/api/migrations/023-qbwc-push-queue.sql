-- Generic outbox for TBWC edits that need to be pushed back to QuickBooks
-- Desktop, starting with SalesOrder.memo. One row per (object_type, txn_id,
-- field_name); a new edit before the last one pushes just overwrites it.
-- field_name is the TBWC/schema-facing name (e.g. "memo_pending"), not the QB
-- XML tag — each QBWC object module owns its own field_name -> QB tag map, so
-- adding another pushable field later needs no migration, just a map entry
-- (see TBWC/api/worker/qbwc/pushQueue.ts, orders.ts's PUSHABLE, and
-- salesOrder.ts's FIELD_TO_QB_TAG).
CREATE TABLE IF NOT EXISTS public.qbwc_push_queue (
  qbwc_push_queue_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_type text NOT NULL,
  txn_id text NOT NULL,
  field_name text NOT NULL,
  new_value text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT qbwc_push_queue_status_check CHECK (status IN ('pending', 'failed')),
  CONSTRAINT qbwc_push_queue_key UNIQUE (object_type, txn_id, field_name)
) TABLESPACE pg_default;

ALTER TABLE public.qbwc_push_queue OWNER TO postgres;
GRANT ALL ON TABLE public.qbwc_push_queue TO anon, authenticated, postgres, service_role;
