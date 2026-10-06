-- Restore quote:delete. Migration 041 granted it (admin 'all' via migration
-- 039/040, rep+customer 'own') for the old TBWC-native quote module, but
-- migration 057 dropped that module and wiped every quote:% grant with it.
-- The qb_estimate-backed rebuild (070 renamed Estimates back to Quote) never
-- re-added a delete grant, so quotes.ts's DELETE route has been gated on
-- quote:write ever since (admin-only, no own-scope check) and the frontend
-- hid the affordance entirely (QuoteList.tsx's allowDelete: false).
INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT r.role_id, 'quote:delete', 'all', ARRAY[]::text[]
  FROM public.role r
 WHERE r.tenant_id IS NULL AND r.code = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT r.role_id, 'quote:delete', 'own', ARRAY[]::text[]
  FROM public.role r
 WHERE r.tenant_id IS NULL AND r.code IN ('rep', 'customer')
ON CONFLICT (role_id, permission) DO NOTHING;
