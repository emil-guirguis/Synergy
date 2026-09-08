-- Order module moves onto public.qb_sales_order (the QB-synced staging table).
-- Adds TBWC-owned columns (the QBWC upsert only SETs synced columns, so these
-- survive every re-sync) plus invoice linkage so the list can show each sales
-- order's invoice number and invoice status.
-- Follows naming convention: {tablename}_id primary keys.

-- ---------------------------------------------------------------------------
-- 1) TBWC-owned columns on qb_sales_order
ALTER TABLE public.qb_sales_order
  ADD COLUMN IF NOT EXISTS build_notes        text,
  ADD COLUMN IF NOT EXISTS expedite           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS no_later_than      date,
  ADD COLUMN IF NOT EXISTS d_net_cost         numeric(15,2),
  ADD COLUMN IF NOT EXISTS overage            numeric(15,2),
  ADD COLUMN IF NOT EXISTS project_admin_fee  numeric(15,2),
  ADD COLUMN IF NOT EXISTS commission_total   numeric(15,2),
  ADD COLUMN IF NOT EXISTS trade_ally_fee     numeric(15,2),
  ADD COLUMN IF NOT EXISTS rep_id             uuid,   -- public.users.id (owning rep; scopes rep visibility)
  -- Denormalised from qb_invoice via LinkedTxn so list filter/sort/search work
  -- through the generic CRUD path. Maintained by refreshOrderInvoiceStatus()
  -- after every SalesOrder/Invoice sync page (and backfilled below).
  ADD COLUMN IF NOT EXISTS invoice_number     text,
  ADD COLUMN IF NOT EXISTS invoice_status     text;

CREATE INDEX IF NOT EXISTS qb_sales_order_rep_id_idx
  ON public.qb_sales_order (rep_id);

-- ---------------------------------------------------------------------------
-- 2) Invoice -> SalesOrder linkage. QB stamps LinkedTxn blocks on InvoiceRet
--    (header and per-line) pointing at the SalesOrder(s) the invoice came from.
--    Stored as jsonb [{"txn_id": "...", "txn_type": "SalesOrder"}, ...].
ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS linked_txn jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS qb_invoice_linked_txn_gin
  ON public.qb_invoice USING gin (linked_txn jsonb_path_ops);

-- Backfill linked_txn from the stored raw InvoiceRet slice. LinkedTxn sits in
-- the header (before the line items), so the 8000-char raw slice nearly always
-- contains it; any invoice whose raw was truncated short self-heals on its next
-- sync (the parser now writes linked_txn directly).
UPDATE public.qb_invoice i
SET linked_txn = sub.lt
FROM (
  SELECT qb_invoice_id,
         COALESCE(
           (SELECT jsonb_agg(DISTINCT jsonb_build_object('txn_id', m[1], 'txn_type', m[2]))
              FROM regexp_matches(
                     raw->>'ret',
                     '<LinkedTxn>\s*<TxnID>([^<]+)</TxnID>\s*<TxnType>([^<]+)</TxnType>',
                     'g') AS m),
           '[]'::jsonb) AS lt
  FROM public.qb_invoice
) sub
WHERE i.qb_invoice_id = sub.qb_invoice_id
  AND i.linked_txn IS DISTINCT FROM sub.lt;

-- ---------------------------------------------------------------------------
-- 3) Backfill invoice_number / invoice_status (same statement the Worker's
--    refreshOrderInvoiceStatus() runs after each sync page).
UPDATE public.qb_sales_order so
SET invoice_number = calc.invoice_number,
    invoice_status = calc.invoice_status
FROM (
  SELECT so2.qb_sales_order_id,
         inv.ref_number AS invoice_number,
         -- Precedence: Paid > Invoiced > Partially Invoiced > Closed > Not Invoiced.
         -- is_fully_invoiced drives 'Invoiced' even without a linked invoice row
         -- (LinkedTxn linkage only exists on invoices pulled after this migration).
         CASE
           WHEN COALESCE(inv.is_paid, false) THEN 'Paid'
           WHEN COALESCE(so2.is_fully_invoiced, false) THEN 'Invoiced'
           WHEN inv.ref_number IS NOT NULL THEN 'Partially Invoiced'
           WHEN COALESCE(so2.is_manually_closed, false) THEN 'Closed'
           ELSE 'Not Invoiced'
         END AS invoice_status
  FROM public.qb_sales_order so2
  LEFT JOIN LATERAL (
    SELECT i.ref_number, i.is_paid
    FROM public.qb_invoice i
    WHERE i.linked_txn @> jsonb_build_array(jsonb_build_object('txn_id', so2.txn_id))
    ORDER BY i.txn_date DESC NULLS LAST, i.qb_invoice_id DESC
    LIMIT 1
  ) inv ON true
) calc
WHERE so.qb_sales_order_id = calc.qb_sales_order_id
  AND (so.invoice_number IS DISTINCT FROM calc.invoice_number
       OR so.invoice_status IS DISTINCT FROM calc.invoice_status);
