-- TBWC-owned estimate status — not from QuickBooks, never touched by the
-- sync; a plain lifecycle flag the rep/admin sets directly (see WRITABLE in
-- routes/estimates.ts). Default 'quote' (the neutral/active state) so every
-- existing and newly-synced row lands somewhere sensible.
ALTER TABLE public.qb_estimate
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'quote';

ALTER TABLE public.qb_estimate DROP CONSTRAINT IF EXISTS qb_estimate_status_check;
ALTER TABLE public.qb_estimate
  ADD CONSTRAINT qb_estimate_status_check CHECK (status IN ('quote', 'on_hold', 'cancelled'));
