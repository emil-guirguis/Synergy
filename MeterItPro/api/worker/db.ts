/**
 * Database module for Cloudflare Worker
 * Uses Hyperdrive for connection pooling to Supabase.
 * Note: Hyperdrive handles connection pooling, so we use Client (not Pool)
 * to avoid double-pooling and connection exhaustion.
 */

import { Client, types } from 'pg';
import { formatSqlForDebug } from '@meterit/framework-backend/shared/helpers/worker-logger';
export { formatSqlForDebug };

// Both parsers keep the host's timezone out of values that don't carry one (TBWC's
// worker db.ts has the same pair — keep them in step).
//
// `timestamp without time zone` is stored as UTC wall-clock, but the wire text has no
// offset, so pg's default parser (OID 1114) builds the Date in the LOCAL time of
// whatever host ran the query: every timestamp comes out shifted by that host's offset.
types.setTypeParser(types.builtins.TIMESTAMP, (val: string) => new Date(val + 'Z'));
// A `date` column is a calendar date — no time, no zone — and pg's parser (OID 1082)
// turns it into a local-midnight Date, which JSON.stringify freezes into an instant.
// Rendering that in the org's timezone drops a day for anyone west of UTC (the bug
// behind TBWC's Orders list showing the day before the ship date in production, while
// dev was right only because the laptop's -07:00 cancelled the display conversion).
// Return the wire text ('2026-10-29') and let the browser format the digits.
types.setTypeParser(types.builtins.DATE, (val: string) => val);

export interface Env {
  DATABASE_URL?: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN?: string;
  FRONTEND_URL?: string;
  HYPERDRIVE: any;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ANTHROPIC_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
  CLIENT_API_URL?: string;
  REMOTE_DB_HOST?: string;
  REMOTE_DB_PORT?: number;
  REMOTE_DB_NAME?: string;
  REMOTE_DB_USER?: string;
  REMOTE_DB_PASSWORD?: string;
  TURNSTILE_SECRET?: string;
}

export async function query(env: Env, text: string, params: any[] = []) {
  const connectionString = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
  const client = new Client({ connectionString });
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

/**
 * Run multiple queries on a single connection without a transaction.
 * Use for hot paths that fire many sequential queries in one request to
 * avoid N startup handshakes. Each call still logs via formatSqlForDebug.
 */
export async function withConnection<T>(
  env: Env,
  callback: (q: (sql: string, params?: any[], logMessage?: string) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>
): Promise<T> {
  const connectionString = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const q = async (sql: string, params: any[] = [], logMessage?: string) => {
      const label = logMessage ? `[withConnection] ${logMessage}` : '[withConnection]';
      console.log(`${label} Executing:\n${formatSqlForDebug(sql, params)}`);
      const start = Date.now();
      const result = await client.query(sql, params);
      console.log(`${label} Rows: ${result.rows?.length ?? result.rowCount ?? 0} | Time: ${Date.now() - start}ms`);
      return { rows: result.rows, rowCount: result.rowCount };
    };
    return await callback(q);
  } finally {
    await client.end();
  }
}

export async function transaction<T>(env: Env, callback: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
  const client = new Client({ connectionString });
  await client.connect();
  const loggingClient = new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return (text: string, params?: any[]) => {
          console.log('[SQL]\n' + formatSqlForDebug(text, params));
          return target.query(text, params as any);
        };
      }
      return (target as any)[prop];
    },
  });
  try {
    await client.query('BEGIN');
    const result = await callback(loggingClient as Client);
    await client.query('COMMIT');
    return result;
  } catch (error: any) {
    await client.query('ROLLBACK');
    // Re-throw error with transaction context
    throw error;
  } finally {
    await client.end();
  }
}
