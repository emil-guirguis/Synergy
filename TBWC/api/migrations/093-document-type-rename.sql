-- TBWC migration 093 — rename rep_doc_type to document_type.
--
-- "rep_doc_type" was named for the rep-docs bucket it started on; 089 added
-- resource-documents reuse of the same type concept, so the rep-specific name
-- no longer fits. Rename table + PK column only (CLAUDE.md convention:
-- [table].[table]_id) — doc_path/doc_type/updated_at columns are unchanged.
ALTER TABLE public.rep_doc_type RENAME TO document_type;
ALTER TABLE public.document_type RENAME COLUMN rep_doc_type_id TO document_type_id;

-- can_read_rep_doc (091) queries the table by name; recreate against the new
-- name so the rep-docs Storage RLS policy keeps working.
CREATE OR REPLACE FUNCTION public.can_read_rep_doc(object_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  effective_type text;
  p text := object_name;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;
  IF NOT public.is_approved_rep() THEN
    RETURN false;
  END IF;

  LOOP
    SELECT doc_type INTO effective_type FROM public.document_type WHERE doc_path = p;
    EXIT WHEN effective_type IS NOT NULL;
    EXIT WHEN position('/' in p) = 0;
    p := regexp_replace(p, '/[^/]*$', '');
  END LOOP;

  RETURN COALESCE(effective_type, 'all') != 'employee';
END;
$$;
