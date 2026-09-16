-- report:read — cross-module admin reports (starting with the Rep Performance
-- & Commission Tracker). Same access as payment:read: admin and employee,
-- not rep/customer — these are company financials (commission payouts,
-- collected revenue), not something a rep should see for other reps.
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT r.role_id, 'report:read', 'all'
  FROM public.role r
 WHERE r.tenant_id IS NULL AND r.code IN ('admin', 'employee')
ON CONFLICT (role_id, permission) DO NOTHING;
