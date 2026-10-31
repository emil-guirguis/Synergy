#!/usr/bin/env node
/**
 * One-time backfill: public.quote.sales_rep_list_id for every row that has
 * free-text sales_rep but no list_id yet — both the pre-existing rows from
 * the old spreadsheet-driven import (scripts/import-quotes.cjs, firm names
 * like "Bell & McCoy") and the ones from scripts/import-quotes-from-folders.cjs
 * ("NAME (email, phone)" parsed off a quote PDF cover page).
 *
 * Why this matters: sales_rep_list_id is quote's ownOnly scoping column
 * (worker/middleware.ts visibleRepListIds, worker/routes/quotes.ts) — a rep-
 * scoped user sees NONE of their own historical quotes while it's null, no
 * matter who they are. See scripts/lib/sales-rep-match.cjs for the matching
 * approach and why it's deliberately conservative (a wrong match would show
 * a quote to the wrong rep, which is worse than showing it to nobody).
 *
 * Confident matches get sales_rep_list_id set. Everything else gets left
 * alone (list_id stays NULL) but has a flag appended to memo so it surfaces
 * for manual assignment instead of silently staying invisible forever.
 *
 * Usage:
 *   node scripts/backfill-sales-rep-id.cjs --dry-run   # report only (default)
 *   node scripts/backfill-sales-rep-id.cjs --commit    # write it
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadRepIndex, matchSalesRep, UNMATCHED_FLAG } = require('./lib/sales-rep-match.cjs');

const API_DIR = path.join(__dirname, '..');

function fromToml(key) {
  const toml = fs.readFileSync(path.join(API_DIR, 'wrangler.toml'), 'utf8');
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return m ? m[1] : null;
}
function fromDevVars(key) {
  const file = path.join(API_DIR, '.dev.vars');
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}
const cfg = (key) => process.env[key] || fromDevVars(key) || fromToml(key);
const DATABASE_URL = cfg('DATABASE_URL');

const OPTS = { commit: process.argv.includes('--commit') };
if (!OPTS.commit) console.log('*** DRY RUN — no DB writes. Pass --commit to write. ***\n');

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();

  const repIndex = await loadRepIndex(client);
  const { rows } = await client.query(
    `SELECT quote_id, job_name, sales_rep, memo FROM public.quote
     WHERE sales_rep_list_id IS NULL AND sales_rep IS NOT NULL AND sales_rep <> ''
     ORDER BY quote_id`
  );

  const byRaw = new Map(); // sales_rep text -> { match, count }
  let matched = 0;
  let unmatched = 0;

  for (const row of rows) {
    const match = matchSalesRep(row.sales_rep, repIndex);
    if (!byRaw.has(row.sales_rep)) byRaw.set(row.sales_rep, { match, count: 0 });
    byRaw.get(row.sales_rep).count++;

    if (match) {
      matched++;
      if (OPTS.commit) {
        // A row that's matching now but didn't on an earlier run (e.g. a
        // new alias was added to the matcher — see BA/"Blanchard
        // Associates" in sales-rep-match.cjs) may still carry that run's
        // "needs manual assignment" note + raw-text dump. Strip anything
        // this script would have appended, not just the flag sentence —
        // leaving the stale note behind now that it HAS been assigned
        // reads as "this still needs attention" to the next person to look.
        const cleanedMemo = (row.memo || '')
          .replace(new RegExp(`\\s*\\|?\\s*Rep: ${row.sales_rep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
          .replace(new RegExp(`\\s*\\|?\\s*${UNMATCHED_FLAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
          .trim();
        const newMemo = cleanedMemo === '' ? null : cleanedMemo;
        await client.query(
          'UPDATE public.quote SET sales_rep_list_id = $1, memo = $2 WHERE quote_id = $3',
          [match.list_id, newMemo, row.quote_id]
        );
      }
    } else {
      unmatched++;
      if (OPTS.commit) {
        // Idempotent: adds whichever piece (the raw rep text, the flag
        // sentence) isn't already in memo, so a re-run on an
        // already-flagged-but-missing-the-raw-text row (an earlier version
        // of this script only appended the flag, not the text) fills in
        // the gap instead of leaving memo saying "couldn't find a rep"
        // with no trace of what it actually found.
        const memo = row.memo || '';
        const pieces = [];
        if (!memo.includes(row.sales_rep)) pieces.push(`Rep: ${row.sales_rep}`);
        if (!memo.includes(UNMATCHED_FLAG)) pieces.push(UNMATCHED_FLAG);
        if (pieces.length > 0) {
          const newMemo = memo ? `${memo}  |  ${pieces.join('  |  ')}` : pieces.join('  |  ');
          await client.query('UPDATE public.quote SET memo = $1 WHERE quote_id = $2', [newMemo, row.quote_id]);
        }
      }
    }
  }

  const summary = [...byRaw.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [raw, { match, count }] of summary) {
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
