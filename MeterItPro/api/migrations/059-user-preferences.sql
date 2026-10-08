-- Per-user display preference overrides (Settings > System Config sets the
-- tenant-wide default; a user can override it for themselves here). NULL
-- means "inherit the tenant default" — see middleware.ts's getCachedUser()
-- COALESCE. Nullable (no default), unlike tenant's system-config columns,
-- so COALESCE can tell "unset" apart from an explicit value.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS timezone varchar(100),
  ADD COLUMN IF NOT EXISTS date_format varchar(50),
  ADD COLUMN IF NOT EXISTS time_format varchar(10),
  ADD COLUMN IF NOT EXISTS default_page_size integer;
