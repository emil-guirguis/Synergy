/**
 * Shared "how far back do we need to ask QB for" helper — every incremental
 * object module queries MAX(time_modified) off its own synced table the same
 * way; centralized here so that shape only needs fixing in one place.
 */
import { Env, execQuery } from '../db';

/** MAX(time_modified) already stored in `table`, as an ISO UTC string, or
 *  null if the table is empty (first run — caller does a full pull). */
export async function sinceModified(env: Env, table: string, label: string): Promise<string | null> {
  const r = await execQuery(env, `SELECT MAX(time_modified) AS m FROM public.${table}`, [], label);
  const m = r.rows[0]?.m;
  return m ? new Date(m).toISOString() : null;
}
