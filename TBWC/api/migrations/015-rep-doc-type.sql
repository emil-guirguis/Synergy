-- Per-file "who sees it" type for the rep-docs Storage bucket. The bucket
-- itself (Supabase Storage) has no queryable custom-metadata column reachable
-- from the plain object-list REST call this app already uses, and it's shared
-- live with tbwc-site's portal.html, so we keep this mapping in our own table
-- instead of touching the bucket's object paths or metadata.
CREATE TABLE IF NOT EXISTS public.rep_doc_type (
  rep_doc_type_id serial PRIMARY KEY,
  doc_path text NOT NULL UNIQUE,
  doc_type text NOT NULL DEFAULT 'all' CHECK (doc_type IN ('rep', 'employee', 'all')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
