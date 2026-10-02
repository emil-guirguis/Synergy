-- Dead column: Rep Approvals access is now gated by the repApproval:write
-- role grant (see permissions.ts), not this per-user flag. Confirmed unused
-- in frontend/backend code before dropping.
ALTER TABLE public.users DROP COLUMN IF EXISTS can_approve_rep_leads;
