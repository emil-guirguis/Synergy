-- Estimates module renamed back to Quote and decoupled from QuickBooks
-- entirely: the Estimate QBWC object was never even wired into the sync
-- registry (qbwc/objects/index.ts had it commented out since it was added),
-- and the "push to QuickBooks" workflow (migrations 056/058/059) is being
-- removed in this same change — so public.qb_estimate goes back to being a
-- plain TBWC-owned table, same role as the original public.quote dropped in
-- migration 057, just keeping the richer qb_estimate-derived shape (real
-- customer_list_id/sales_rep_list_id references, jsonb lines) instead of
-- quote_line's separate child-table/FK design.
ALTER TABLE public.qb_estimate RENAME TO quote;
ALTER TABLE public.quote RENAME COLUMN qb_estimate_id TO quote_id;
ALTER TABLE public.quote RENAME CONSTRAINT qb_estimate_txn_id_key TO quote_txn_id_key;
ALTER TABLE public.quote RENAME CONSTRAINT qb_estimate_status_check TO quote_status_check;

-- pending_add (migration 058) only ever flagged a draft for the now-removed
-- EstimateAddRq push — nothing sets or reads it once routes/quotes.ts drops
-- the push endpoint.
ALTER TABLE public.quote DROP COLUMN IF EXISTS pending_add;

-- 'draft' (migration 056) only ever existed for Estimate's held-back-until-
-- pushed staging; SalesOrder (the only other queueFieldPush caller) always
-- used the 'pending' default. No push_queue rows for quotes survive this
-- rename either way.
DELETE FROM public.qbwc_push_queue WHERE object_type = 'Estimate';
ALTER TABLE public.qbwc_push_queue DROP CONSTRAINT IF EXISTS qbwc_push_queue_status_check;
ALTER TABLE public.qbwc_push_queue
  ADD CONSTRAINT qbwc_push_queue_status_check CHECK (status IN ('pending', 'failed'));

-- The object was never in the sync registry, so these should already be
-- empty — cleaned up in case a prior build ever enabled it.
DELETE FROM public.qbwc_map WHERE object_type = 'Estimate';
DELETE FROM public.qbwc_sync_run WHERE object_type = 'Estimate';
DELETE FROM public.qbwc_pull_cursor WHERE object_type = 'Estimate';

-- Existing attachments keyed by the old entity_type (routes/documents.ts).
UPDATE public.document SET entity_type = 'quote' WHERE entity_type = 'estimate';

-- Replaces the estimate:read/write catalog entries (migration 056).
UPDATE public.role_permission SET permission = 'quote:read' WHERE permission = 'estimate:read';
UPDATE public.role_permission SET permission = 'quote:write' WHERE permission = 'estimate:write';
