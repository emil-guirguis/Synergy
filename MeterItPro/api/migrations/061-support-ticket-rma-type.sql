-- Adds 'rma' to support_ticket.type's allowed values, matching the shared
-- schema enum (framework/backend/api/base/supportTicketSchema.ts).
ALTER TABLE public.support_ticket DROP CONSTRAINT IF EXISTS support_ticket_type_check;
ALTER TABLE public.support_ticket ADD CONSTRAINT support_ticket_type_check
  CHECK (type::text = ANY (ARRAY['bug'::text, 'feature_request'::text, 'billing'::text, 'account'::text, 'technical'::text, 'general'::text, 'rma'::text]));
