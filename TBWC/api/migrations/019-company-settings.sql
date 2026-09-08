-- Company settings — singleton row backing the Settings page (org info +
-- system config). Mirrors the column names MeterItPro's public.tenant table
-- uses for the same fields (see framework/backend/api/base/settings.ts),
-- so both apps share one row<->shape mapper.
-- Follows naming convention: {tablename}_id primary keys.

CREATE TABLE IF NOT EXISTS public.company_settings (
  company_settings_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 ),
  name              text,
  street            text,
  street2           text,
  city              text,
  state             text,
  zip               text,
  country           text,
  url               text,
  contact_email     text,
  timezone          text,
  date_format       text,
  time_format       text NOT NULL DEFAULT '12h',
  currency          text,
  language          text,
  default_page_size integer NOT NULL DEFAULT 20,
  created_at        timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at        timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT company_settings_pkey PRIMARY KEY (company_settings_id)
) TABLESPACE pg_default;

ALTER TABLE IF EXISTS public.company_settings OWNER to postgres;
-- Worker connects as postgres (table owner, bypasses RLS); PostgREST roles get no
-- access — the Settings page reads through the Worker's admin-only API, not Supabase REST.
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.company_settings TO postgres;
GRANT ALL ON TABLE public.company_settings TO service_role;

-- Seed the single settings row — name left blank for an admin to fill in.
-- Idempotent: only inserts when the table is empty (migration may re-run).
INSERT INTO public.company_settings (name)
SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM public.company_settings);
