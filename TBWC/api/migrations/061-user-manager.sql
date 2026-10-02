-- Flat "manages" relation: a manager sees their own orders plus every user
-- they manage's orders (see routes/orders.ts ownOnly scoping). Configured by
-- an admin on the Users form's "Manages" tab (admin-only module already —
-- see users.ts) — no self-service, no multi-level chains (reports of reports
-- are out of scope on purpose).

CREATE TABLE IF NOT EXISTS public.user_manager (
  user_manager_id   bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manager_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  managed_user_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_manager_no_self CHECK (manager_id <> managed_user_id),
  CONSTRAINT user_manager_unique UNIQUE (manager_id, managed_user_id)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_user_manager_manager ON public.user_manager (manager_id);
CREATE INDEX IF NOT EXISTS idx_user_manager_managed ON public.user_manager (managed_user_id);

ALTER TABLE public.user_manager OWNER TO postgres;
-- Worker connects as postgres (table owner, bypasses RLS). RLS on + no
-- policies means PostgREST roles get nothing — mirrors 026/060.
ALTER TABLE public.user_manager ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.user_manager TO postgres;
GRANT ALL ON TABLE public.user_manager TO service_role;
