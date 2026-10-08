-- Lets a notification deep-link to the record it's about (Share feature).
-- NULL for ordinary notifications that aren't about a specific record.
ALTER TABLE public.notification
  ADD COLUMN IF NOT EXISTS link_url text;
