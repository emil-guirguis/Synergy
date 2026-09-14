-- Reps could always delete their own quotes (routes/quotes.ts guarded DELETE
-- with the same `is_admin || own row` check as PUT). Migration 040 gave them
-- quote:read and quote:write but not quote:delete, which would have taken that
-- away as a side effect of moving quotes onto the permission model rather than
-- as a decision anyone made. Grant it, own-scoped, to match what they had.
--
-- Drop this migration's grant if reps genuinely shouldn't delete quotes — but
-- then it's a deliberate change, not an accident of the rollout.
INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT r.role_id, 'quote:delete', 'own', ARRAY[]::text[]
  FROM public.role r
 WHERE r.tenant_id IS NULL AND r.code IN ('rep', 'customer')
ON CONFLICT (role_id, permission) DO NOTHING;
