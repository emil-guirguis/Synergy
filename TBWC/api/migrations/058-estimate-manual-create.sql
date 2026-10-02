-- Estimates can now be created manually in TBWC (not just synced from QB) and
-- pushed to QuickBooks as a new record — a local draft has no txn_id until
-- QB's EstimateAddRs assigns one (see qbwc/objects/estimate.ts's pendingAddRqs).
ALTER TABLE public.qb_estimate ALTER COLUMN txn_id DROP NOT NULL;

-- Set by routes/estimates.ts's POST /:id/push for a still-local draft (txn_id
-- IS NULL) — flags it for estimate.ts's next buildRequest() to send as an
-- EstimateAddRq. Distinct from qbwc_push_queue's 'draft'/'pending' (that
-- tracks per-field edits on an EXISTING QB record; a brand-new record has no
-- txn_id to key push_queue rows by at all).
ALTER TABLE public.qb_estimate ADD COLUMN IF NOT EXISTS pending_add boolean NOT NULL DEFAULT false;
