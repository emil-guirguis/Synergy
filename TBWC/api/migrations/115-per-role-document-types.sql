-- TBWC migration 115 — document types become a per-role setting.
--
-- Which document types a role may see was a hardcoded list of four
-- customer-facing types in documents.ts (REP_VISIBLE_ORDER_DOC_TYPES), applied
-- to orders only, and only to callers without orderGridDocument:write. A new
-- role could not be given a different set without editing that file.
--
-- It is now stored like every other field rule — `doc_type:<value>` view bits
-- on the module's Documents read grant, editable in Settings > Roles >
-- <Module> > Documents > Type (see documentGridSchema.ts's perOptionAccess and
-- allowedOptions() in the framework's permissions.ts). Open by default: a
-- grant that names no types allows them all, so adding a type to DOC_TYPES
-- never silently hides it from existing roles.
--
-- Which means the old rule has to be written down for the roles that were
-- relying on it, or they would widen on deploy. That is every role holding
-- orderGridDocument:read WITHOUT orderGridDocument:write — today the Customer
-- role (and any custom role in that shape), plus the "managing rep" carve-out,
-- whose write access comes from public.user_manager rather than a grant and is
-- therefore limited by its read grant's types. Admin and Employee hold write,
-- were never narrowed, and stay unnarrowed.
--
-- Deliberately only order documents: the old list was never applied to quote,
-- invoice, inventory or support files, so seeding those would be a new
-- restriction, not a preserved one.

UPDATE public.role_permission rp
   SET hidden_fields = ARRAY(
         SELECT DISTINCT h
           FROM unnest(rp.hidden_fields || ARRAY[
                  'doc_type:cutsheet', 'doc_type:order', 'doc_type:shipping',
                  'doc_type:email', 'doc_type:design', 'doc_type:quote',
                  'doc_type:rma', 'doc_type:shipping_images',
                  'doc_type:change_order', 'doc_type:waiver',
                  'doc_type:panelboard_schedules', 'doc_type:build_of_materials',
                  'doc_type:credit_memo', 'doc_type:other'
                ]) AS h
       )
 WHERE rp.permission = 'orderGridDocument:read'
   AND NOT EXISTS (
         SELECT 1 FROM public.role_permission w
          WHERE w.role_id = rp.role_id
            AND w.permission = 'orderGridDocument:write'
       );
