-- TBWC migration 117 — grants for the new AR Aging report (nav: Reports > AR
-- Aging, routes/arAging.ts, permission arAging:read).
--
-- The permission itself lives in code (permissions.ts); this only seeds the
-- grant rows so the page isn't invisible to everyone on deploy. Mirrored off
-- invoiceTotals:read — the closest existing report, over the same qb_invoice
-- rows — at that grant's own scope, so an 'own'-scoped role reads its own late
-- book and nobody gains sight of a figure they couldn't already compute from
-- the Invoices list.
--
-- Additive: nothing is updated or dropped. Apply once — a role whose
-- arAging:read is later unticked in Settings > Roles has its row deleted, and
-- re-running this would hand the grant back.

INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT rp.role_id, 'arAging:read', rp.scope, rp.hidden_fields
  FROM public.role_permission rp
 WHERE rp.permission = 'invoiceTotals:read'
ON CONFLICT (role_id, permission) DO NOTHING;
