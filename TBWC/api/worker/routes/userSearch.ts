/**
 * Name matching for the AI chat `search_users` tool.
 *
 * The tool used to be one substring ILIKE over the whole query string, so
 * asking it to notify "Jennifer Crenshaw" returned nothing at all — the user
 * on file is "Jenifer Crenshaw", one n — and the assistant told the caller no
 * such user exists. Any person reading that would have found her.
 *
 * So: match per word, not on the whole string, and rank by how much of the
 * query a row accounts for. "Jennifer Crenshaw" then matches on the surname
 * and comes back for the assistant to confirm. When even that finds nobody,
 * `prefixTerms` retries on short word prefixes, which is what catches a
 * misspelling in the only word given ("Jennifer" alone → "Jen%" → Jenifer).
 *
 * Kept as pure functions (the SQL is built here, the ranking happens here)
 * rather than one clever query: trigram/levenshtein matching would mean
 * depending on pg_trgm or fuzzystrmatch being installed in the Supabase
 * project, and this is testable without a database.
 */

export interface UserSearchRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  agency_name?: string | null;
}

/** Below this, a word is noise for matching purposes ("a", "of"). */
const MIN_TERM_LENGTH = 2;

/** How much of a word has to survive for the misspelling fallback. Three
 *  characters is what makes Jennifer/Jenifer, Micheal/Michael and
 *  Steven/Stephen meet; longer stops matching at the very letter that
 *  usually differs. */
const PREFIX_LENGTH = 3;

/** Words that say who is being looked for rather than naming them — they'd
 *  otherwise match e-mail addresses and agency names wholesale. */
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'for', 'to', 'user', 'users', 'rep', 'reps', 'mr', 'mrs', 'ms', 'dr']);

/** Drops quotes, brackets and trailing punctuation from the outside of a term
 *  while leaving e-mail characters alone, so a quoted or comma-terminated name
 *  still matches. */
function stripEdges(value: string): string {
  return value.replace(/^[^\p{L}\p{N}@._-]+|[^\p{L}\p{N}@._-]+$/gu, '');
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** The query broken into the words worth matching on, longest first so the
 *  most distinctive word ranks a row highest. The whole string stays in the
 *  list: an exact "first last" or e-mail match should still outrank a row
 *  that only shares a surname. */
export function searchTerms(text: string): string[] {
  const whole = stripEdges(text.trim());
  if (!whole) return [];
  const words = whole
    .split(/[\s,]+/)
    .map(stripEdges)
    .filter((w) => w.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(w.toLowerCase()));

  const terms = dedupe([whole, ...words].filter((t) => t.length >= MIN_TERM_LENGTH));
  return terms.sort((a, b) => b.length - a.length);
}

/** Last-resort terms for a query whose spelling doesn't match anything on
 *  file: each word cut to its first PREFIX_LENGTH characters. Returns [] when
 *  that would add nothing (every word already shorter than the prefix). */
export function prefixTerms(text: string): string[] {
  const prefixes = searchTerms(text)
    .filter((t) => !/\s/.test(t) && t.length > PREFIX_LENGTH)
    .map((t) => t.slice(0, PREFIX_LENGTH));
  return dedupe(prefixes);
}

/** `WHERE` clause + params matching any of `terms` against any name/e-mail
 *  field. One ILIKE per term rather than a single clever predicate, so the
 *  ranking below can be done on the rows in TypeScript where it's testable. */
export function buildUserSearchQuery(terms: string[], limit: number): { sql: string; params: unknown[] } {
  const conditions = terms
    .map((_, i) => {
      const p = `$${i + 1}`;
      return `(u.first_name ILIKE '%' || ${p} || '%'
            OR u.last_name ILIKE '%' || ${p} || '%'
            OR u.email ILIKE '%' || ${p} || '%'
            OR COALESCE(u.agency_name, '') ILIKE '%' || ${p} || '%'
            OR (COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) ILIKE '%' || ${p} || '%')`;
    })
    .join('\n         OR ');

  return {
    sql: `SELECT u.id, u.first_name, u.last_name, u.email, u.agency_name
          FROM public.users u
          WHERE ${conditions}
          ORDER BY u.first_name, u.last_name
          LIMIT $${terms.length + 1}`,
    params: [...terms, limit],
  };
}

function fieldsOf(row: UserSearchRow): string[] {
  const full = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
  return [row.first_name ?? '', row.last_name ?? '', row.email ?? '', row.agency_name ?? '', full]
    .filter(Boolean)
    .map((f) => f.toLowerCase());
}

/** How well one row answers the query: the number of query words it matches,
 *  with a bonus for matching the query as a whole (an exact "first last" hit
 *  beats a shared surname) and for matching a word outright rather than as a
 *  substring of a longer one. */
function scoreRow(row: UserSearchRow, terms: string[]): number {
  const fields = fieldsOf(row);
  let score = 0;
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!fields.some((f) => f.includes(needle))) continue;
    score += /\s/.test(term) ? 3 : 1;
    if (fields.some((f) => f === needle)) score += 1;
  }
  return score;
}

/** Rows the query actually matched, best first. Rows matching none of the
 *  terms are dropped — with per-term SQL matching, a loose term can otherwise
 *  drag in someone the caller plainly didn't mean. */
export function rankUsers(rows: UserSearchRow[], terms: string[]): UserSearchRow[] {
  return rows
    .map((row) => ({ row, score: scoreRow(row, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.row);
}
