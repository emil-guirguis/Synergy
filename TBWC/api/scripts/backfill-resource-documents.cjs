#!/usr/bin/env node
/**
 * One-time backfill: register every existing file in the `rep-docs` Storage
 * bucket (the Resources module) as a row in public.document
 * (entity_type='resource', entity_id/storage_path = the bucket object path),
 * so the existing document search/AI tools (search_documents,
 * search_document_contents in aiChat.ts) cover Resources too — see
 * migrations/089-resource-documents.sql for the partial unique index this
 * relies on.
 *
 * Idempotent (ON CONFLICT DO NOTHING) — safe to re-run; new uploads after
 * this point are inserted live by the Worker (routes/docTypes.ts), not by
 * this script.
 *
 * Usage:
 *   node scripts/backfill-resource-documents.cjs --dry-run
 *   node scripts/backfill-resource-documents.cjs --commit
 *
 * Config (DATABASE_URL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) resolves the
 * same way as scripts/import-quotes.cjs: env > .dev.vars > wrangler.toml.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const API_DIR = path.join(__dirname, '..');
const BUCKET = 'rep-docs';

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
if (!COMMIT) console.log('*** DRY RUN — no DB writes. Pass --commit to write. ***\n');

function authHeaders() {
  return SERVICE_KEY.startsWith('eyJ')
    ? { Authorization: `Bearer ${SERVICE_KEY}` }
    : { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
}

/** One directory listing (non-recursive). Mirrors frontend storageService.ts's listRaw. */
async function list(prefix) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error(`list ${prefix}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const rows = await res.json();
  const files = [];
  const folders = [];
  for (const e of rows || []) {
    if (e.id) {
      if (e.name === '.emptyFolderPlaceholder') continue;
      files.push({
        path: prefix ? `${prefix}/${e.name}` : e.name,
        size: e.metadata?.size ?? null,
        mimeType: e.metadata?.mimetype ?? null,
      });
    } else {
      folders.push(e.name);
    }
  }
  return { files, folders };
}

/** Recursively walk the whole bucket into a flat file list. */
async function walkAll(prefix) {
  const { files, folders } = await list(prefix);
  let out = files;
  for (const sub of folders) {
    out = out.concat(await walkAll(prefix ? `${prefix}/${sub}` : sub));
  }
  return out;
}

async function main() {
  const files = await walkAll('');

  if (!COMMIT) {
    for (const f of files) console.log(`- ${f.path} (${f.size ?? '?'} bytes, ${f.mimeType ?? 'unknown mime'})`);
    return;
  }

  const client = new Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  let inserted = 0;
  try {
    for (const f of files) {
      const fileName = f.path.slice(f.path.lastIndexOf('/') + 1);
      // created_at is backdated to the epoch, not "now" — aiSearch.ts's content-search
      // slow pass windows to the newest 200 document rows (ORDER BY created_at DESC).
      // Stamping all 626 backfilled rows with today's date would bury every genuine
      // order/invoice/quote attachment out of that window in one shot. A live upload
      // through docTypes.ts (upsertResourceDocument) still gets a real "now" — only
      // this one-time bulk backfill needs to stay out of the way of real recency.
      const result = await client.query(
        `INSERT INTO public.document
           (entity_type, entity_id, doc_type, file_name, mime_type, file_size, storage_bucket, storage_path, created_at)
         VALUES ('resource', $1, 'other', $2, $3, $4, $5, $1, 'epoch')
         ON CONFLICT (entity_id) WHERE entity_type = 'resource' DO NOTHING`,
        [f.path, fileName, f.mimeType, f.size, BUCKET]
      );
      if (result.rowCount > 0) inserted++;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
