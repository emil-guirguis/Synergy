-- TBWC migration 116 — the last five order fields move from a hardcoded
-- variant gate to the rep role's own grant.
--
-- order_type, due_date, ship_no_later_than, jay and service carried
-- visibleFor: ['admin'] in orderSchema.ts, which BaseForm's variant filter
-- applied before the role was consulted. That gate was one-way: RolesForm only
-- ever persists a denial (an unticked field writes view:false; a ticked one
-- writes nothing), so a role could never be granted a variant-gated field, and
-- ticking it in Settings > Roles did nothing at all. The gates are gone — every
-- order field is now the role grant's call.
--
-- Day-one access unchanged: the rep role gets these five added to the fields it
-- already hides on order:read (migrations 040 + 113), so a rep sees exactly
-- what they saw before. The difference is that it is now editable per role —
-- untick/tick in Settings > Roles > Order > Fields, no migration needed.
--
-- Safe to redact from the payload rather than just the form: the rep order list
-- never reads any of them (REP_FIELD_ORDER in OrderList.tsx, and the Statuses
-- column whose chips read order_type is admin-only), and OrderForm's
-- isPlaceholder check simply reads false without order_type — reps don't edit
-- placeholder orders.
--
-- Rep only. `customer` keeps the narrower reading migration 040 gave it.
-- Idempotent: the fields are unioned into the existing array, never appended
-- blindly, so re-running changes nothing.
UPDATE public.role_permission rp
   SET hidden_fields = ARRAY(
         SELECT DISTINCT h
           FROM unnest(
                  rp.hidden_fields
                  || ARRAY['order_type', 'due_date', 'ship_no_later_than', 'jay', 'service']
                ) AS h
          ORDER BY h
       )
  FROM public.role r
 WHERE r.role_id = rp.role_id
   AND r.tenant_id IS NULL
   AND r.code = 'rep'
   AND rp.permission = 'order:read';
