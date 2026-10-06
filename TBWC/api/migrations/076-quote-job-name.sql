-- "Job Name" on a quote — same TBWC-owned, manually-entered concept as
-- qb_sales_order.job_name (migration 020), no QB source. The AI chat
-- quote-creation wizard asks for it right after create_quote (customer +
-- rep are set there), before moving on to line items.
ALTER TABLE public.quote
  ADD COLUMN IF NOT EXISTS job_name text;
