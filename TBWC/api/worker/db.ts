/**
 * Database module for the TBWC Cloudflare Worker.
 * Connects to the tbwc-site Supabase Postgres via Hyperdrive (connection pooling).
 * Uses pg Client (Hyperdrive already pools) — mirrors MeterItPro's worker db.
 */
import { Client, types } from 'pg';
import { formatSqlForDebug } from '@meterit/framework-backend/shared/helpers/worker-logger';
export { formatSqlForDebug };

// DB stores `timestamp without time zone` columns as UTC wall-clock (DB timezone
// is UTC). pg's default parser for that type (OID 1114) has no offset in the wire
// text, so it falls back to building the Date with the LOCAL time of whatever host
// runs the query instead of UTC — every timestamp column comes out shifted by the
// host's UTC offset. Force UTC interpretation to match how the data is actually stored.
types.setTypeParser(types.builtins.TIMESTAMP, (val: string) => new Date(val + 'Z'));

export interface Env {
  DATABASE_URL?: string;
  HYPERDRIVE: any;
  FRONTEND_URL?: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  // QBWC SOAP auth. Set in prod via `wrangler secret put QBWC_USERNAME|QBWC_PASSWORD`.
  // Unset in local dev falls back to the dev defaults in routes/qbwc.ts.
  QBWC_USERNAME?: string;
  QBWC_PASSWORD?: string;
  // Absolute path to the .qbw company file on the QB Desktop machine. Set it to
  // run unattended (QBWC starts QuickBooks and opens the file itself); leave it
  // unset and the connector uses whatever file is already open. See routes/qbwc.ts.
  QBWC_COMPANY_FILE?: string;
  // Service role key — lets the cron (no browser/admin session to borrow a
  // token from) call Supabase edge functions. Set via `wrangler secret put
  // SUPABASE_SERVICE_ROLE_KEY`. See worker/mail.ts.
  SUPABASE_SERVICE_ROLE_KEY?: string;
  // Base URL (incl. subpath) of the deployed TBWC portal, e.g.
  // "https://emil-guirguis.github.io/Synergy/TBWCPortal/". Used to build the
  // re-verification link mailed to locked-out reps. Distinct from
  // FRONTEND_URL, which is CORS-origin-only (no path).
  PORTAL_URL?: string;
  // Groq API key for /api/ai/chat (tool-use assistant). Set via
  // `wrangler secret put GROQ_API_KEY` in prod; local dev uses .dev.vars.
  // Unset => the route returns 503 instead of calling out.
  GROQ_API_KEY?: string;
}

export async function query(env: Env, text: string, params: any[] = []) {
  // Prefer an explicit DATABASE_URL (local dev / direct connection, needs SSL to
  // the Supabase pooler); otherwise use the Hyperdrive-provided string (prod,
  // which manages its own TLS).
  const directUrl = env.DATABASE_URL;
  const connectionString = directUrl || env.HYPERDRIVE?.connectionString;
  // The Supabase pooler accepts non-SSL connections; using ssl:false avoids
  // workerd's incomplete Postgres-TLS support in local dev. Hyperdrive (prod)
  // manages its own TLS.
  const client = new Client(
    directUrl ? { connectionString, ssl: false } : { connectionString }
  );
  await client.connect();
  try {
    return await client.query(text, params);
  } catch (error: any) {
    error.sql = text;
    error.sqlParams = params;
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Run `fn` inside a single BEGIN/COMMIT transaction on one connection.
 * `fn` receives a `q(sql, params)` bound to that connection so every statement
 * shares the transaction (execQuery opens a fresh Client per call and cannot).
 * Rolls back and rethrows on any error.
 */
export async function withTransaction<T>(
  env: Env,
  fn: (q: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>
): Promise<T> {
  const directUrl = env.DATABASE_URL;
  const connectionString = directUrl || env.HYPERDRIVE?.connectionString;
  const client = new Client(
    directUrl ? { connectionString, ssl: false } : { connectionString }
  );
  await client.connect();
  const q = async (text: string, params: any[] = []) => {
    console.log(`[withTransaction] Executing:\n${formatSqlForDebug(text, params)}`);
    return client.query(text, params);
  };
  try {
    await client.query('BEGIN');
    const result = await fn(q);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    await client.end();
  }
}

export async function execQuery(
  env: Env,
  sql: string,
  params?: any[],
  logMessage?: string
): Promise<{ rows: any[]; rowCount: number | null }> {
  const label = logMessage ? `[execQuery] ${logMessage}` : '[execQuery]';
  console.log(`${label} Executing:\n${formatSqlForDebug(sql, params || [])}`);
  const start = Date.now();
  try {
    const result = await query(env, sql, params);
    console.log(`${label} Rows: ${result.rows?.length ?? result.rowCount ?? 0} | Time: ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    console.error(`${label} Failed: ${error}`);
    throw error;
  }
}
