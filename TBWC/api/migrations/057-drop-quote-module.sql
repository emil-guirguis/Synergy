-- Retire the TBWC-native quote/quote_line module — superseded by the
-- QuickBooks-Estimate-backed Estimates module (public.qb_estimate). Nothing
-- ever attached documents to a quote (checked: no public.document rows with
-- entity_type = 'quote'), so this is a clean drop, no orphaned attachments.
DROP TABLE IF EXISTS public.quote_line CASCADE;
DROP TABLE IF EXISTS public.quote CASCADE;

DELETE FROM public.role_permission WHERE permission LIKE 'quote:%';
