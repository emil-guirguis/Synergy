-- payment:read — the new Payments module (public.qb_payment, the AR side of
-- the QB sync). Same access as customer:read: admin and employee, not rep/customer.
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT r.role_id, 'payment:read', 'all'
  FROM public.role r
 WHERE r.tenant_id IS NULL AND r.code IN ('admin', 'employee')
ON CONFLICT (role_id, permission) DO NOTHING;
