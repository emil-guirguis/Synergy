-- CSAT (customer satisfaction) rating for a resolved/closed ticket — the
-- filer rates 1-5 from the ticket page once it's resolved. Feeds the Support
-- Analytics summary (avg CSAT) alongside ticket volume / avg resolution time,
-- both already derivable from existing columns (created_at/resolved_at).
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS csat_rating smallint;
ALTER TABLE public.support_ticket ADD COLUMN IF NOT EXISTS csat_submitted_at timestamp without time zone;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_ticket_csat_rating_check') THEN
    ALTER TABLE public.support_ticket
      ADD CONSTRAINT support_ticket_csat_rating_check CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5);
  END IF;
END $$;
