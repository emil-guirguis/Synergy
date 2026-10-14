-- TBWC migration 099 — drop order:read's old per-line keys.
--
-- APPLY ONLY AFTER the Worker with orderGridLine:read (097) is deployed to
-- production — until then the old Worker is what hides reps' line prices, via
-- exactly these keys. 097 already copied them onto orderGridLine:read; once
-- the new Worker is live they're dead weight on order:read (no longer shown
-- in Settings > Roles, so they'd silently keep hiding columns after someone
-- un-hides them on Order > Line Items).
UPDATE public.role_permission
   SET hidden_fields = ARRAY(SELECT h FROM unnest(hidden_fields) AS h WHERE h NOT LIKE 'lines[].%'),
       field_access  = COALESCE((SELECT jsonb_object_agg(e.k, e.v)
                                   FROM jsonb_each(field_access) AS e(k, v)
                                  WHERE e.k NOT LIKE 'lines[].%'), '{}'::jsonb)
 WHERE permission = 'order:read';
