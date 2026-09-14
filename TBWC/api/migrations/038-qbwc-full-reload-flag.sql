-- Per-object "full reload" request flag for the QB Sync dashboard's reload
-- button. Set it, and that object's next QBWC pull drops its incremental
-- FromModifiedDate/ModifiedDateRangeFilter so QB re-sends every record; the
-- flag is cleared once the pull's iterator is confirmed fully drained
-- (markDrainComplete in pullCursor.ts), so a session that dies mid-pull leaves
-- the reload pending rather than half-done.
--
-- Safe by construction: every staging upsert is ON CONFLICT (list_id|txn_id)
-- DO UPDATE naming only QB-owned columns, so a reload rewrites what QB owns and
-- leaves TBWC-owned columns (qb_item.image_url/notes/type, the order's
-- build_notes/expedite/commission/..., document links, kit_items and
-- quote_line FKs) untouched. No staging row is ever deleted by a pull.
ALTER TABLE public.qbwc_pull_cursor
  ADD COLUMN IF NOT EXISTS full_reload_requested_at timestamptz;

COMMENT ON COLUMN public.qbwc_pull_cursor.full_reload_requested_at IS
  'Set by POST /api/qb-sync/reload; next pull for this object type ignores the incremental filter. Cleared on confirmed full drain.';
