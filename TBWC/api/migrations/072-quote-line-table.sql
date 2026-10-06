-- Quote line items move off the jsonb quote.lines column onto a real child
-- table, so totals/aggregates can be computed in SQL (SUM) instead of only
-- in application code walking a jsonb array — needed by the AI chat quote
-- wizard (routes/aiChat.ts), which appends one line at a time and must keep
-- quote.total correct after each append.
--
-- This table existed before (migration 004), was dropped in 057 when the
-- module got superseded by the QB-Estimate-backed Estimates module, and came
-- back as jsonb in 070 only because that's the shape qb_estimate.lines had.
-- Quotes are TBWC-local again (no QB sync) so there's no reason to keep the
-- jsonb shape now that real math over lines is needed.
-- Follows naming convention: {tablename}_id primary keys.

CREATE TABLE public.quote_line (
  quote_line_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id      bigint NOT NULL REFERENCES public.quote (quote_id) ON DELETE CASCADE,
  -- Nullable: a custom/free-text line (no catalog item) is allowed, same as
  -- the old quote_line design. ON DELETE SET NULL so retiring a catalog item
  -- doesn't destroy historical quote lines quoted against it.
  qb_item_id    bigint REFERENCES public.qb_item (qb_item_id) ON DELETE SET NULL,
  item_name     text,
  description   text,
  quantity      numeric(12,2) NOT NULL DEFAULT 1,
  rate          numeric(15,2) NOT NULL DEFAULT 0,
  amount        numeric(15,2) NOT NULL DEFAULT 0,
  line_order    integer NOT NULL DEFAULT 0,
  created_at    timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX quote_line_quote_id_idx ON public.quote_line (quote_id);

ALTER TABLE public.quote_line ENABLE ROW LEVEL SECURITY;

-- Backfill existing jsonb lines (item/itemValue/desc/quantity/rate/amount —
-- see PickableLineItemsGrid.tsx) into rows, preserving order.
INSERT INTO public.quote_line (quote_id, qb_item_id, item_name, description, quantity, rate, amount, line_order)
SELECT
  q.quote_id,
  NULLIF(elem->>'itemValue', '')::bigint,
  elem->>'item',
  elem->>'desc',
  COALESCE((elem->>'quantity')::numeric(12,2), 1),
  COALESCE((elem->>'rate')::numeric(15,2), 0),
  COALESCE((elem->>'amount')::numeric(15,2), 0),
  (ord - 1)::integer
FROM public.quote q
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(q.lines, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
WHERE jsonb_typeof(q.lines) = 'array';

-- Recompute total from the migrated rows rather than trusting the old
-- app-computed column, now that SUM is authoritative.
UPDATE public.quote q
   SET total = COALESCE((SELECT SUM(ql.amount) FROM public.quote_line ql WHERE ql.quote_id = q.quote_id), 0);

ALTER TABLE public.quote DROP COLUMN lines;
