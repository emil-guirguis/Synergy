/**
 * Durable "confirmed fully drained through" watermark per QB object type —
 * separate from a staging table's own MAX(time_modified). See migration 025
 * for why: a staging table's MAX() advances the moment any row lands, even if
 * the iterator that fetched it never finished paging (QB reported no more
 * pages when it should have, or the QBWC session ended mid-Continue). Once
 * that happens, an incremental FromModifiedDate filter permanently skips
 * whatever older backlog never got fetched. confirmed_through only moves
 * forward when a pull's iterator is confirmed fully drained.
 */
import { Env, execQuery } from '../db';

export interface PullCursorState {
  confirmedThrough: string | null;
  drainPending: boolean;
  /** Set while a full reload is queued for this object (migration 038) — the
   *  next pull drops its incremental filter so QB re-sends every record. */
  fullReloadRequestedAt: string | null;
}

export async function getPullCursor(env: Env, objectType: string): Promise<PullCursorState> {
  const r = await execQuery(
    env,
    `SELECT confirmed_through, drain_pending, full_reload_requested_at
     FROM public.qbwc_pull_cursor WHERE object_type = $1`,
    [objectType],
    'qbwc.pullCursor.get'
  );
  if (!r.rows.length) return { confirmedThrough: null, drainPending: false, fullReloadRequestedAt: null };
  const row = r.rows[0];
  return {
    confirmedThrough: row.confirmed_through ? new Date(row.confirmed_through).toISOString() : null,
    drainPending: !!row.drain_pending,
    fullReloadRequestedAt: row.full_reload_requested_at
      ? new Date(row.full_reload_requested_at).toISOString()
      : null,
  };
}

/** Queue a full re-pull of this object: the next QBWC session asks QB for every
 *  record instead of only what changed since the watermark. Idempotent — asking
 *  twice before a session runs is one reload. */
export async function requestFullReload(env: Env, objectType: string): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO public.qbwc_pull_cursor (object_type, full_reload_requested_at)
     VALUES ($1, CURRENT_TIMESTAMP)
     ON CONFLICT (object_type) DO UPDATE
       SET full_reload_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
    [objectType],
    'qbwc.pullCursor.requestFullReload'
  );
}

/** More pages are still pending for this object's iterator — don't let the
 *  incremental watermark advance until a later pull confirms full drain. */
export async function markDrainPending(env: Env, objectType: string): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO public.qbwc_pull_cursor (object_type, drain_pending)
     VALUES ($1, true)
     ON CONFLICT (object_type) DO UPDATE SET drain_pending = true, updated_at = CURRENT_TIMESTAMP`,
    [objectType],
    'qbwc.pullCursor.markPending'
  );
}

/** This object's iterator reported no further pages — everything matching the
 *  filter in flight has now been fetched, so it's safe to trust the data's own
 *  MAX(time_modified) as the watermark again from this instant on. */
export async function markDrainComplete(env: Env, objectType: string): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO public.qbwc_pull_cursor (object_type, confirmed_through, drain_pending)
     VALUES ($1, CURRENT_TIMESTAMP, false)
     ON CONFLICT (object_type) DO UPDATE
       SET confirmed_through = CURRENT_TIMESTAMP, drain_pending = false,
           -- A queued full reload is satisfied only by a drained iterator, so
           -- clearing it here (and nowhere else) means a session that dies
           -- mid-pull leaves the reload pending for the next one.
           full_reload_requested_at = NULL,
           updated_at = CURRENT_TIMESTAMP`,
    [objectType],
    'qbwc.pullCursor.markComplete'
  );
}
