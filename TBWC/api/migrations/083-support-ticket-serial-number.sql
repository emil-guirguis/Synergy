-- Support tickets can reference a specific product's serial number (e.g. a
-- defective-unit / RMA report) — see framework/backend/api/base/supportTicketSchema.ts.
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS serial_number varchar(100);
