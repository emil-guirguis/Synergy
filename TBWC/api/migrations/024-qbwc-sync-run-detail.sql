-- Free-text detail for a sync run row (e.g. "Deleted order TBWC 5687"),
-- separate from `error` so it doesn't trip the dashboard's failed/red styling.
-- First consumer: salesOrderDeleted.ts logs one row per deleted SalesOrder
-- instead of one vague aggregate "TxnDeleted: N" row.
ALTER TABLE public.qbwc_sync_run ADD COLUMN IF NOT EXISTS detail text;

