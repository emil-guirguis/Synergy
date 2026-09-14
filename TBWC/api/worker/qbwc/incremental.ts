/**
 * Shared "how far back do we need to ask QB for" helper — every incremental
 * object module queries MAX(time_modified) off its own synced table the same
 * way; centralized here so that shape only needs fixing in one place.
 */
import { Env, execQuery } from '../db';
import { getPullCursor } from './pullCursor';

/** MAX(time_modified) already stored in `table`, as an ISO UTC string, or
 *  null if the table is empty (first run — caller does a full pull). */
export async function sinceModified(env: Env, table: string, label: string): Promise<string | null> {
  const r = await execQuery(env, `SELECT MAX(time_modified) AS m FROM public.${table}`, [], label);
  const m = r.rows[0]?.m;
  return m ? new Date(m).toISOString() : null;
}

/**
 * The pull window for one object, in precedence order:
 *   1. A queued full reload (the dashboard's per-table reload button) -> null,
 *      i.e. no filter at all, so QB re-sends every record. Cleared only once
 *      the iterator drains, so an interrupted reload runs again next session.
 *   2. A pending drain -> the last confirmed-safe point, never the staging
 *      table's own MAX(time_modified) (see pullCursor.ts / migration 025).
 *   3. Otherwise -> MAX(time_modified) on the staging table.
 * Null means "ask for everything": both listModifiedFilter and
 * txnModifiedFilter render '' for it.
 */
export async function pullSince(
  env: Env,
  objectType: string,
  table: string,
  label: string
): Promise<string | null> {
  const cursor = await getPullCursor(env, objectType);
  if (cursor.fullReloadRequestedAt) {
    console.log(`[QBWC] ${objectType}: full reload queued ${cursor.fullReloadRequestedAt} — pulling every record`);
    return null;
  }
  if (cursor.drainPending) return cursor.confirmedThrough;
  return sinceModified(env, table, label);
}
