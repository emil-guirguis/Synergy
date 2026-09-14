-- qb_invoice.po_number: QB's InvoiceRet <PONumber>, promoted to a real column.
--
-- Why: the order form's billing panel (and orderInvoiceStatus.ts) link invoices
-- to a sales order through qb_invoice.linked_txn, but QB only emits <LinkedTxn>
-- when the query asks for it, and InvoiceQueryRq did not until this change
-- (see qbwc/objects/invoice.ts). Result: linked_txn is '[]' on all ~7.8k synced
-- invoices, and stays that way for every one of them until each is touched in
-- QB again and re-pulled. The PO number is the fallback link -- 4449 of 4583
-- orders match an invoice on (customer_list_id, po_number).
--
-- The backfill reads the retained raw InvoiceRet rather than waiting on a
-- re-sync, so the panel works immediately; the sync keeps the column current
-- from here on.
ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS po_number text;

UPDATE public.qb_invoice
   SET po_number = nullif(btrim((regexp_match(raw->>'ret', '<PONumber>([^<]*)</PONumber>'))[1]), '')
 WHERE po_number IS NULL
   AND raw->>'ret' LIKE '%<PONumber>%';

-- Supports the panel's fallback lookup (customer + PO) per order.
CREATE INDEX IF NOT EXISTS qb_invoice_customer_po_idx
  ON public.qb_invoice (customer_list_id, po_number);

COMMENT ON COLUMN public.qb_invoice.po_number IS
  'QB InvoiceRet PONumber. Fallback link to qb_sales_order when linked_txn is empty.';
