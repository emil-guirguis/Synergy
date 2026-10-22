-- TBWC migration 114 — drop users.is_admin and users.type.
--
-- Both predate the role model (migration 039). A boolean and a three-value
-- enum cannot express a role, so every check built on them disagreed with the
-- real grants the moment a custom role existed: the Employee role holds
-- order:write but got a read-only order form, a user flagged is_admin while
-- carrying the Employee role got admin-only UI, and a new role made in
-- Settings > Roles was invisible to both. What a user may do now comes from
-- public.role_permission alone, checked in the Worker.
--
-- APPLY ONLY AFTER:
--   1. the Worker + portal that stop reading these columns are deployed
--      (loadProfile selects them today — dropping them first 500s every
--      authenticated request), and
--   2. tbwc-site's retirement of admin.html is live, with the rewired
--      Supabase edge functions (delete-rep / delete-lead now check
--      user:write / repApproval:write grants) deployed. That page was the last
--      browser-side reader of these columns, of the rep-docs bucket and of the
--      public.users admin policies dropped below.
--   3. migration 112 (rep-docs policies -> Worker-brokered) is applied. Its
--      drops are repeated here as IF EXISTS so this file cannot leave a
--      policy behind that reads a dropped column, but 112 is where that move
--      is explained.
--
-- Not dropped here: users.can_see_orders and users.can_approve_rep_leads.
-- can_approve_rep_leads() still guards the three rep_leads policies that the
-- portal's Rep Approvals page reaches through PostgREST; that table moves to
-- the Worker next, and those two columns go with it.

-- --- policies that read the columns -----------------------------------------
-- public.users: the admin page these served is retired. The portal reads users
-- through the Worker (user:read / user:write), which connects as a privileged
-- role; a signed-in browser keeps users_select_own, which is all the sign-in
-- approval gate needs.
DROP POLICY IF EXISTS users_select_admin ON public.users;
DROP POLICY IF EXISTS users_update_admin ON public.users;
DROP POLICY IF EXISTS users_delete_admin ON public.users;

-- rep-docs: migration 112's drops, repeated idempotently (see note 3 above).
DROP POLICY IF EXISTS rep_docs_select ON storage.objects;
DROP POLICY IF EXISTS rep_docs_insert ON storage.objects;
DROP POLICY IF EXISTS rep_docs_update ON storage.objects;
DROP POLICY IF EXISTS rep_docs_delete ON storage.objects;

-- --- the helper functions built on the columns ------------------------------
-- can_read_rep_doc: 112 drops it; it calls both helpers below.
-- is_full_access_staff: already orphaned (migration 111 dropped its only
--   policy) and reads users.type.
DROP FUNCTION IF EXISTS public.can_read_rep_doc(text);
DROP FUNCTION IF EXISTS public.is_full_access_staff();
DROP FUNCTION IF EXISTS public.is_admin();
DROP FUNCTION IF EXISTS public.is_approved_rep();

-- --- the columns ------------------------------------------------------------
-- users_type_check goes with the column it checks.
ALTER TABLE public.users DROP COLUMN IF EXISTS is_admin;
ALTER TABLE public.users DROP COLUMN IF EXISTS type;
