-- Bring public.qb_estimate up to the columns the Estimates module needs:
--   memo               QB-owned (EstimateRet.Memo), same push-queue pattern as
--                       qb_sales_order.memo — a PUT never writes it directly,
--                       only queues an edit (see qbwc_push_queue below).
--   sales_rep_list_id  captured off EstimateRet.SalesRepRef, mirrors
--                       qb_sales_order — lets a rep's estimates be scoped the
--                       same way their orders are (OWNER_COLUMN.estimate).
--   sales_rep          denormalised SalesRepRef.FullName (QB puts the rep's
--                       short Initial code here, same caveat as orders).
ALTER TABLE public.qb_estimate
  ADD COLUMN IF NOT EXISTS memo text,
  ADD COLUMN IF NOT EXISTS sales_rep_list_id text,
  ADD COLUMN IF NOT EXISTS sales_rep text;

-- Estimates are editable in TBWC before they're pushed back to QuickBooks, but
-- deliberately NOT auto-pushed the way an order's memo edit is (queued the
-- moment it's saved) — the user pushes explicitly via a button. 'draft' is
-- that in-between state: queued (so GET can show it immediately) but excluded
-- from qbwc/pushQueue.ts's pendingPushes() (status IN ('pending','failed')),
-- so it's never sent to QB until routes/estimates.ts's push endpoint promotes
-- it to 'pending'.
ALTER TABLE public.qbwc_push_queue DROP CONSTRAINT IF EXISTS qbwc_push_queue_status_check;
ALTER TABLE public.qbwc_push_queue
  ADD CONSTRAINT qbwc_push_queue_status_check CHECK (status IN ('draft', 'pending', 'failed'));

-- Replaces the retired quote:read/write/delete catalog entries.
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT r.role_id, 'estimate:read', 'all'
  FROM public.role r
 WHERE r.code = 'admin' AND r.tenant_id IS NULL
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT r.role_id, 'estimate:write', 'all'
  FROM public.role r
 WHERE r.code = 'admin' AND r.tenant_id IS NULL
ON CONFLICT (role_id, permission) DO NOTHING;

-- Reps/employees/customers see their own estimates, read-only, same scope
-- column as orders (sales_rep_list_id) — no write grant, matching "low lights,
-- not editable yet" for non-admins.
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT r.role_id, 'estimate:read', 'own'
  FROM public.role r
 WHERE r.code IN ('employee', 'rep', 'customer') AND r.tenant_id IS NULL
ON CONFLICT (role_id, permission) DO NOTHING;
