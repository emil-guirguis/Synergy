-- Per-user display preference overrides (Settings > System Config sets the
-- org-wide default; a user can override it for themselves here). NULL means
-- "inherit the org default" — see middleware.ts's loadProfile() COALESCE.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS date_format text,
  ADD COLUMN IF NOT EXISTS time_format text,
  ADD COLUMN IF NOT EXISTS default_page_size integer;
