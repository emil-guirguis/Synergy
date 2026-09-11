-- Rep-scoped invoices. Reps get the Invoices module read-only, seeing only
-- their own, so qb_invoice needs the owning rep as a real column the list can
-- filter on (same shape as qb_sales_order.sales_rep_list_id).
--
-- QB puts SalesRepRef straight on InvoiceRet — no join to the sales order is
-- needed. (LinkedTxn would have been the other route, but InvoiceQueryRq is not
-- sent with IncludeLinkedTxns, so qb_invoice.linked_txn is '[]' on every row
-- here and resolves nothing. That is also why qb_sales_order.invoice_number is
-- still null across the board — a separate, pre-existing gap.)
--
-- Null means "QB recorded no rep on this invoice" (~350 of 7.8k): invisible to
-- reps, still visible to admins, who see the unscoped table.

ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS sales_rep_list_id text;

-- The rep list filter is the hot path for this column (every rep list request).
CREATE INDEX IF NOT EXISTS qb_invoice_sales_rep_list_id_idx
  ON public.qb_invoice (sales_rep_list_id);

-- Backfill from the stored InvoiceRet slice so existing rows work without
-- waiting on a full re-sync. SalesRepRef sits in the header, well inside the
-- 8000-char slice qb_invoice.raw keeps. Rows synced from now on get the value
-- written directly by the sync (qbwc/objects/invoice.ts).
UPDATE public.qb_invoice
SET sales_rep_list_id = substring(raw->>'ret' from '<SalesRepRef>[[:space:]]*<ListID>([^<]+)</ListID>')
WHERE raw->>'ret' LIKE '%<SalesRepRef>%'
  AND sales_rep_list_id IS DISTINCT FROM
      substring(raw->>'ret' from '<SalesRepRef>[[:space:]]*<ListID>([^<]+)</ListID>');
