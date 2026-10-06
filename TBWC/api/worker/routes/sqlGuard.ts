/**
 * Guardrails for the AI chat `run_sql_query` tool.
 *
 * The Worker connects as the table owner, which bypasses RLS, so whatever the
 * model writes runs with full read of the database. Two separate jobs here:
 *
 *  1. Keep the statement read-only. A keyword scan does that, but it has to
 *     run on the SQL alone - scanning the raw text rejected honest queries
 *     like `WHERE note = 'insert'` or a column named `created_by`.
 *  2. Keep it to the tables the assistant is meant to answer from. public.*
 *     and information_schema.* only; auth/storage/vault and the Postgres role
 *     catalogues hold credentials and session data that no chat answer needs.
 */

/** Replaces string literals, quoted identifiers and comments with blanks, so
 *  keyword scanning sees only SQL. Lengths are preserved so a reported match
 *  still lines up with the original statement. */
export function stripLiterals(sql: string): string {
  let out = '';
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');

  while (i < sql.length) {
    const rest = sql.slice(i);

    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += blank(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        // '' and "" are escaped quotes inside the literal, not the end of it.
        if (sql[j] === quote && sql[j + 1] === quote) j += 2;
        else if (sql[j] === quote) break;
        else j++;
      }
      const stop = Math.min(j + 1, sql.length);
      out += blank(sql.slice(i, stop));
      i = stop;
      continue;
    }

    out += sql[i];
    i++;
  }
  return out;
}

/** Statements that change data or reach outside the database. */
const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|call|merge|vacuum|reindex|cluster|listen|notify|refresh|lock|do|pg_sleep|dblink|pg_read_file|pg_read_binary_file|pg_write_file|lo_import|lo_export|set|reset|into)\b/i;

/** Objects outside what the assistant answers questions from. Supabase keeps
 *  auth tokens and uploaded-file metadata in these schemas, and the Postgres
 *  role catalogues hold password hashes and connection settings. */
const BLOCKED_OBJECTS =
  /\b(auth|storage|vault|cron|net|extensions|supabase_functions|supabase_migrations|graphql|realtime)\s*\.|\bpg_(authid|shadow|roles|user|user_mapping|settings|stat_activity|statistic|hba_file_rules|read_file|ls_dir)\b/i;

export interface SqlGuardResult {
  ok: boolean;
  error?: string;
  /** The statement to run, with a trailing semicolon removed. */
  statement?: string;
}

export function checkSqlQuery(raw: string): SqlGuardResult {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { ok: false, error: 'sql is required' };

  const statement = trimmed.replace(/;\s*$/, '');
  const sqlOnly = stripLiterals(statement);

  if (sqlOnly.includes(';')) {
    return { ok: false, error: 'Only a single statement is allowed — remove the semicolon(s).' };
  }
  if (!/^\s*(select|with)\b/i.test(sqlOnly)) {
    return { ok: false, error: 'Only SELECT (or WITH ... SELECT) queries are allowed.' };
  }

  const write = sqlOnly.match(WRITE_KEYWORDS);
  if (write) {
    return {
      ok: false,
      error: `Disallowed keyword "${write[0]}" — only read-only SELECT queries are permitted.`,
    };
  }

  const blocked = sqlOnly.match(BLOCKED_OBJECTS);
  if (blocked) {
    return {
      ok: false,
      error:
        `"${blocked[0].trim()}" is out of bounds — query the application's own tables ` +
        `(public schema), or information_schema for column discovery.`,
    };
  }

  return { ok: true, statement };
}
