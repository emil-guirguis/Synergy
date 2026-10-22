-- TBWC migration 113 — reps see an order's totals, but not its commission.
--
-- Migration 040 hid every dollar figure on qb_sales_order from the rep (and
-- customer) role, which also emptied the order form's Summary panel down to a
-- line-item count: the panel's Order total / Freight / Invoiced / Paid /
-- Outstanding rows all need `total` and `freight`, and the first two are
-- redacted out of the payload without them.
--
-- Reps should see what the order is worth and what has been billed against it
-- — they already see every figure on their own invoices (040 left
-- invoice:read with no hidden fields, so Invoiced/Paid/Outstanding were
-- visible all along). Commission is the figure that stays hidden, along with
-- the cost/margin breakdown behind it:
--   sold_for, d_net_cost, overage      - what TBWC paid and marked up
--   commission, commission_total       - the rep's own commission math
--   project_admin_fee, trade_ally_fee
--   raw                                - the stored QB XML, which carries the
--                                        order total AND every line amount
-- Per-line money stays hidden too: that is orderGridLine:read's own
-- rate/amount grant (migration 097), untouched here.
--
-- Rep only. `customer` keeps the narrower reading 040 gave it — a customer
-- role has no features of its own yet, so nothing has asked for this.
UPDATE public.role_permission rp
   SET hidden_fields = ARRAY(SELECT h FROM unnest(rp.hidden_fields) AS h
                              WHERE h NOT IN ('total', 'freight'))
  FROM public.role r
 WHERE r.role_id = rp.role_id
   AND r.tenant_id IS NULL
   AND r.code = 'rep'
   AND rp.permission = 'order:read';
