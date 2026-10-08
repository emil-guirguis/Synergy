-- Serial numbers placed on an order — manual entry (QuickBooks Desktop here
-- doesn't track serials; checked qbxml.ts's lineItems(), no SerialNumber tag
-- pulled on SalesOrderLineRet/InvoiceLineRet). A warehouse/admin logs each
-- serial as units ship, tied to the specific line it came off (txn_line_id,
-- the stable id already in qb_sales_order.lines jsonb — see qbxml.ts's
-- lineItems()). item is denormalised at write time purely for display, since
-- lines is jsonb and not joinable.
-- Follows naming convention: {tablename}_id primary keys.

CREATE TABLE public.order_line_serial (
  order_line_serial_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  qb_sales_order_id    bigint NOT NULL REFERENCES public.qb_sales_order (qb_sales_order_id) ON DELETE CASCADE,
  txn_line_id           text,
  item                  text,
  serial_number         text NOT NULL,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_line_serial_order_id_idx ON public.order_line_serial (qb_sales_order_id);

ALTER TABLE public.order_line_serial OWNER TO postgres;
-- Worker connects as postgres (table owner, bypasses RLS). RLS on + no
-- policies means PostgREST roles get nothing; reads/writes go through the
-- app's own API. Mirrors 026-documents.sql / 072-quote-line-table.sql.
ALTER TABLE public.order_line_serial ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.order_line_serial TO postgres;
GRANT ALL ON TABLE public.order_line_serial TO service_role;
