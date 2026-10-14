-- TBWC migration 095 — child-grid permission keys renamed to <parent>Grid<Child>.
--
-- 094 granted quoteLine:*; child-grid schemas are now named
-- <parent>Grid<Child> (quoteGridLine, orderGridLine, userGridManager, ...) so
-- each parent's grids sort and group together in code and in Settings > Roles.
-- The permission key is the schema key (permissions.ts CHILD_SCHEMAS), so the
-- granted rows follow the rename. Scope and field_access carry over as-is.
UPDATE public.role_permission
   SET permission = replace(permission, 'quoteLine:', 'quoteGridLine:')
 WHERE permission LIKE 'quoteLine:%';
