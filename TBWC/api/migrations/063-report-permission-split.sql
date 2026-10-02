-- Splits report:read into one permission per Reports sub-page
-- (repPerformance:read, orderToCash:read, invoiceTotals:read) — same shape
-- as 062's document->resource split. report:read gated all 3 routes
-- identically, so the roles tree could only ever show one "Report" leaf
-- instead of the sidebar's three (Rep Performance / Order-to-Cash /
-- Invoice Totals).
--
-- Seeded to mirror every existing report:read grant exactly (migration 045:
-- admin + employee, 'all' scope), so no one's access changes on deploy.
-- The old report:read rows are then removed — permissions.ts no longer
-- lists it, so they'd just be dead rows (resolvePermissions ignores
-- anything outside the catalog) if left behind.

INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT rp.role_id, p.permission, rp.scope, rp.hidden_fields
  FROM public.role_permission rp
 CROSS JOIN (VALUES
    ('repPerformance:read'), ('orderToCash:read'), ('invoiceTotals:read')
  ) AS p(permission)
 WHERE rp.permission = 'report:read'
ON CONFLICT (role_id, permission) DO NOTHING;

DELETE FROM public.role_permission WHERE permission = 'report:read';
