-- Support ticket filer contact info + order/invoice reference fields, plus an
-- admin-only resolution memo. ticket_number is NOT a stored column — it's
-- computed from support_ticket_id at query time (routes/support.ts), same
-- reasoning as orders/invoices using their real QB-synced numbers: no
-- sequence/race condition to manage, and it's always in sync with the PK.
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS contact_phone varchar(30);
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS contact_email varchar(200);
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS job_name text;
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS po_number varchar(100);
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS order_number varchar(100);
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS invoice_number varchar(100);
-- Admin-written notes on how the ticket was resolved — distinct from
-- `description` (the filer's own original report). Gated by support:write
-- same as every other edit field (routes/support.ts PUT is admin-only already).
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS resolution_notes text;
