#!/usr/bin/env node
/**
 * One-time backfill: extract text + build the search_vector for every
 * existing public.document row that predates full-text content search
 * (migrations/092-document-extracted-text.sql). After this, the Worker's
 * own cron (worker/index.ts's scheduled() -> backfillDocumentIndex) keeps
 * new/missed rows caught up on its own — this script exists only so the
 * backlog doesn't wait on 15-minute cron ticks the first time.
 *
 * Mirrors framework/backend/api/base/aiSearch.ts's extractDocumentText —
 * duplicated rather than imported, same as every other script here (they're
 * plain Node, the framework package is ESM-bundled for the Worker, and no
 * other script in this dir imports it either). Keep the two in sync if the
 * extraction logic changes.
 *
 * Usage:
 *   node scripts/backfill-extracted-text.cjs --dry-run
 *   node scripts/backfill-extracted-text.cjs --commit
 *   node scripts/backfill-extracted-text.cjs --commit --limit=500
 *
 * Config (DATABASE_URL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) resolves the
 * same way as scripts/import-quotes.cjs: env > .dev.vars > wrangler.toml.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const API_DIR = path.join(__dirname, '..');
const MAX_FILE_SIZE = 20 * 1024 * 1024;

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
const SUPABASE_URL = cfg('SUPABASE_URL');
const SERVICE_KEY = cfg('SUPABASE_SERVICE_ROLE_KEY');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
// A plain bigint LIMIT param can't bind Infinity — 1,000,000 is "no cap" for
// any realistic document count but still a valid finite value.
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 1_000_000;
if (!COMMIT) console.log('*** DRY RUN — no DB writes. Pass --commit to write. ***\n');

function authHeaders() {
  return SERVICE_KEY.startsWith('eyJ')
    ? { Authorization: `Bearer ${SERVICE_KEY}` }
    : { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
}

/** Postgres text columns reject a literal NUL byte outright (a malformed
 *  PDF's embedded fonts can emit one) — strip it plus other C0 controls
 *  before writing, same fix as aiSearch.ts's sanitizeExtractedText. This is
 *  the fix for a real crash: the first --commit run died on doc 305/10,053
 *  with `invalid byte sequence for encoding "UTF8": 0x00` and (since nothing
 *  below caught it) lost the remaining ~9,748 docs in that run. */
// Two real .xlsx uploads (document_id 7983/7986, "NOVARTIS BUILD SHEET") ran
// to ~10MB of CSV'd sheet data and blew the pooler's statement_timeout even
// inside an explicit transaction with SET LOCAL — and raw spreadsheet dump
// text isn't useful full-text-search material anyway. Same cap as
// aiSearch.ts's sanitizeExtractedText.
const MAX_EXTRACTED_TEXT_LENGTH = 500_000;

function sanitizeText(text) {
  let out = '';
  for (let i = 0; i < text.length && out.length < MAX_EXTRACTED_TEXT_LENGTH; i++) {
    const code = text.charCodeAt(i);
    const isTabLfCr = code === 9 || code === 10 || code === 13;
    if (isTabLfCr || code >= 32) out += text[i];
  }
  return out;
}

async function fetchBytes(bucket, objectPath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, { headers: authHeaders() });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/** Mirrors aiSearch.ts's extractDocumentText. */
async function extractText(bytes, mimeType, fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  try {
    if (mime.startsWith('text/') || mime === 'application/json' || ['txt', 'csv', 'json', 'md', 'log', 'xml', 'html', 'htm'].includes(ext)) {
      return bytes.toString('utf-8');
    }
    if (mime === 'application/pdf' || ext === 'pdf') {
      const { extractText: pdfExtractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await pdfExtractText(pdf, { mergePages: true });
      return text;
    }
    if (mime.includes('wordprocessingml') || ext === 'docx') {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      return value;
    }
    if (mime.includes('spreadsheetml') || ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(bytes, { type: 'buffer' });
      return wb.SheetNames.map((name) => XLSX.utils.sheet_to_csv(wb.Sheets[name])).join('\n');
    }
  } catch (e) {
    console.warn(`  extract failed for ${fileName}: ${e.message}`);
    return '';
  }
  return '';
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: false });
  // pg's Client is an EventEmitter — a connection drop (pooler idle-killed a
  // long-lived connection; this run processes thousands of docs over many
  // minutes) emits 'error' on the client itself, and with no listener Node's
  // default behavior is to crash the whole process regardless of any
  // try/catch around the query that was in flight. This run already died
  // once that way (doc 7601/9748, "Connection terminated unexpectedly") —
  // logging it here instead just ends main() cleanly so the retry loop
  // (idempotent via WHERE extracted_text IS NULL) can relaunch.
  let connectionDead = false;
  client.on('error', (err) => {
    connectionDead = true;
    console.error('\nDB connection error:', err.message);
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT document_id, file_name, mime_type, storage_bucket, storage_path
         FROM public.document
        WHERE extracted_text IS NULL
          AND storage_bucket IS NOT NULL AND storage_path IS NOT NULL
          AND (file_size IS NULL OR file_size <= $1)
        ORDER BY document_id ASC
        LIMIT $2`,
      [MAX_FILE_SIZE, LIMIT]
    );
    console.log(`Found ${rows.length} un-indexed document(s).\n`);

    let indexed = 0;
    let empty = 0;
    let failed = 0;
    for (const row of rows) {
      // Once the connection drops, further queries on this same client are
      // unreliable (may reject, may hang) — stop cleanly and let a fresh
      // invocation (idempotent) pick up the rest rather than risk a hang.
      if (connectionDead) {
        console.log(`\nConnection dropped — stopping early. Re-run to continue (${rows.length - indexed - empty - failed} left in this batch).`);
        break;
      }
      try {
        const bytes = await fetchBytes(row.storage_bucket, row.storage_path);
        if (!bytes) {
          console.log(`- [fetch failed] ${row.file_name} (${row.storage_bucket}/${row.storage_path})`);
          failed++;
          continue;
        }
        const text = sanitizeText(await extractText(bytes, row.mime_type, row.file_name));
        if (!text) empty++;
        console.log(`- [${text ? `${text.length} chars` : 'no text'}] ${row.file_name}`);
        if (COMMIT) {
          // DATABASE_URL is Supabase's transaction-mode pooler (port 6543) —
          // a bare top-level `SET statement_timeout` doesn't reliably survive
          // to the next statement there (the pooler can hand different
          // statements to different backend connections). `SET LOCAL` inside
          // an explicit transaction DOES apply, because transaction-mode
          // pooling keeps one whole transaction on one backend connection.
          // Needed for a couple of ~10MB-of-text .xlsx rows whose tsvector
          // computation exceeded the pooler's default timeout.
          await client.query('BEGIN');
          try {
            await client.query('SET LOCAL statement_timeout = 120000');
            await client.query(
              `UPDATE public.document
                  SET extracted_text = $2, search_vector = to_tsvector('english', $2), extracted_at = now()
                WHERE document_id = $1`,
              [row.document_id, text]
            );
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
          }
        }
        indexed++;
      } catch (e) {
        // One bad document (extraction crash, a write the DB rejects for a
        // reason sanitizeText doesn't cover) must not lose every document
        // queued after it — log and move on instead of letting main()'s
        // top-level catch abort the whole run.
        console.log(`- [FAILED: ${e.message}] ${row.file_name}`);
        failed++;
      }
    }
    console.log(`\n${COMMIT ? 'Indexed' : 'Would index'} ${indexed} document(s) — ${empty} with no extractable text, ${failed} failure(s) left for the next run.`);
  } finally {
    try {
      await client.end();
    } catch {
      // Already-dead connection — nothing to close.
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
