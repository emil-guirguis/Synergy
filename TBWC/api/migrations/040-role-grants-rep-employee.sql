-- Real access rules for the seeded roles. Migration 039 deliberately seeded
-- every non-admin role identically, preserving the old is_admin behaviour; this
-- sets what each one should actually be. Separate migration because 039 is
-- already applied — editing it would leave the file disagreeing with the DB.
--
-- Rep:      quotes, orders, invoices (plus the rep document library and the
--           dashboard they land on). Own rows only. No dollar value on an order
--           is visible to them, anywhere in the payload.
-- Employee: everything except the administrative modules (users, settings, QB
--           sync), all rows, no hidden fields.
-- Admin:    unchanged, the full catalog.
--
-- Customer is given the same treatment as rep: it exists only because
-- users.type allows it, has no features of its own, and the narrower of the two
-- possible readings is the right default for an access rule.

-- Rewritten wholesale per role rather than patched, so the result doesn't depend
-- on what 039 happened to seed.
DELETE FROM public.role_permission
 WHERE role_id IN (SELECT role_id FROM public.role
                    WHERE tenant_id IS NULL AND code IN ('rep', 'customer', 'employee'));

-- --- rep + customer ---------------------------------------------------------
--
-- The hidden_fields list on order:read is the point of this migration. Every
-- dollar figure on qb_sales_order is named here, including the two that are not
-- plain columns:
--   raw          - the stored QB SalesOrderRet XML, which contains the order
--                  total and every line amount. SELECT qb_sales_order.* ships
--                  it to the browser, so omitting it would leak everything the
--                  named columns above it carefully hide.
--   lines[].rate - per-line money inside the jsonb detail column. The column
--   lines[].amount  itself has to survive: item/desc/quantity is what the rep's
--                  line-items tab is for. See redactRow() in the framework.
-- `total` is QB's own order total and belongs in this list as much as sold_for
-- does; it was visible on the rep order form until now.
INSERT INTO public.role_permission (role_id, permission, scope, hidden_fields)
SELECT r.role_id, p.permission, p.scope, p.hidden_fields
  FROM public.role r
 CROSS JOIN (VALUES
    ('order:read', 'own', ARRAY[
        'total', 'sold_for', 'd_net_cost', 'overage', 'commission',
        'commission_total', 'project_admin_fee', 'trade_ally_fee',
        'raw', 'lines[].rate', 'lines[].amount'
      ]),
    -- Reps see every field on their own invoices: totals, balance and paid
    -- status included. Deliberately no hidden_fields here.
    ('invoice:read',   'own', ARRAY[]::text[]),
    ('quote:read',     'own', ARRAY[]::text[]),
    ('quote:write',    'own', ARRAY[]::text[]),
    ('document:read',  'all', ARRAY[]::text[]),
    ('dashboard:read', 'own', ARRAY[]::text[])
  ) AS p(permission, scope, hidden_fields)
 WHERE r.tenant_id IS NULL AND r.code IN ('rep', 'customer');

-- --- employee ---------------------------------------------------------------
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT r.role_id, p.permission, 'all'
  FROM public.role r
 CROSS JOIN (VALUES
    ('order:read'), ('order:write'), ('order:delete'),
    ('quote:read'), ('quote:write'), ('quote:delete'),
    ('invoice:read'),
    ('customer:read'),
    ('inventory:read'), ('inventory:write'),
    ('document:read'), ('document:write'),
    ('aichat:use'),
    ('dashboard:read')
    -- Excluded on purpose: user:*, setting:*, qbsync:* stay administrative.
  ) AS p(permission)
 WHERE r.tenant_id IS NULL AND r.code = 'employee';
