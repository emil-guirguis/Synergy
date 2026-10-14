-- TBWC migration 097 — read-only QuickBooks grids get their own permissions.
--
-- Order lines, invoice lines and a payment's applied-to list are jsonb arrays
-- on their parent row (QB-synced), now declared as child-grid schemas
-- (orderGridLineSchema.ts / invoiceGridLineSchema.ts /
-- paymentGridAppliedSchema.ts, `read` only). The routes drop the array
-- without <key>:read and redact each element by that grant's hidden fields.
--
-- Day-one access unchanged:
--   order:read   -> orderGridLine:read
--   invoice:read -> invoiceGridLine:read
--   payment:read -> paymentGridApplied:read
-- and order:read's per-line column rules (hidden_fields / field_access keys
-- 'lines[].rate', 'lines[].amount' — reps can't see line prices) are COPIED to
-- orderGridLine:read as plain 'rate' / 'amount', since that grant is what now
-- redacts the lines. 'lines[].' is 8 characters, hence substr(.., 9).
--
-- Copied, not moved: the previously-deployed Worker still redacts lines via
-- order:read's 'lines[].*' keys, so removing them before the new Worker is
-- live would show reps line prices. 099 removes them — apply AFTER deploy.

INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields, field_access)
SELECT rp.role_id, 'orderGridLine:read', rp.scope,
       ARRAY(SELECT substr(h, 9) FROM unnest(rp.hidden_fields) AS h WHERE h LIKE 'lines[].%'),
       COALESCE((SELECT jsonb_object_agg(substr(e.k, 9), e.v)
                   FROM jsonb_each(rp.field_access) AS e(k, v)
                  WHERE e.k LIKE 'lines[].%'), '{}'::jsonb)
  FROM public.role_permission rp
 WHERE rp.permission = 'order:read'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, 'invoiceGridLine:read', rp.scope
  FROM public.role_permission rp
 WHERE rp.permission = 'invoice:read'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO public.role_permission (role_id, permission, scope)
SELECT rp.role_id, 'paymentGridApplied:read', rp.scope
  FROM public.role_permission rp
 WHERE rp.permission = 'payment:read'
ON CONFLICT (role_id, permission) DO NOTHING;
