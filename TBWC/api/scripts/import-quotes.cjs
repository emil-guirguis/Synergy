#!/usr/bin/env node
/**
 * One-time bulk import: "2026 Quote List" spreadsheet -> public.quote, plus
 * each row's Dropbox-synced local folder -> public.document (quote PDFs +
 * email thread) and best-effort parsed Bill-of-Materials line items ->
 * public.quote_line.
 *
 * The spreadsheet has NO customer or quote-number column (just
 * Representative/Job Name/Engineer/Quote Amount/Date Quoted/PO Received/
 * Link to Folder), so every imported row gets customer_list_id = NULL —
 * someone matches the real QuickBooks customer by hand later per quote.
 * "Representative" is a rep FIRM name (e.g. "Bell & McCoy"), not an
 * individual qb_sales_rep row, so it's stored as free-text quote.sales_rep
 * only; sales_rep_list_id stays NULL (no FK match attempted).
 *
 * The "Link to Folder" column is a dead Dropbox web URL for almost every
 * row (only ~10/155 have one) — folder matching instead walks --folders by
 * Job Name against the local Dropbox-synced directory, which has one
 * subfolder per project regardless of whether the spreadsheet link field
 * was ever filled in.
 *
 * Each project folder holds 1 "<name> Email.pdf" (attached as doc_type
 * 'email') plus one or more "...Quote & Submittals..." PDFs (doc_type
 * 'quote', all attached). Only the newest-dated one (by M.D.YY in the
 * filename, else mtime) gets its Bill-of-Materials pages parsed for line
 * items — older revisions are kept as documents only. Some quote PDFs print
 * a per-line unit/extended price column, some don't (cost hidden from that
 * revision's template); when absent, quote_line.rate/amount land at 0 and
 * the line is still useful for qty + description.
 *
 * quote.total is ALWAYS the spreadsheet's Quote Amount — never recomputed
 * from parsed lines, since the PDF parse is best-effort and the sheet total
 * is authoritative.
 *
 * Usage:
 *   node scripts/import-quotes.cjs --dry-run                 # report only, no writes
 *   node scripts/import-quotes.cjs --dry-run --only "Jones"   # one row, for checking the parser
 *   node scripts/import-quotes.cjs --commit                   # actually write + upload
 *   node scripts/import-quotes.cjs --commit --limit 5         # write just the first 5 matched rows
 *
 * Config (DATABASE_URL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) resolves the
 * same way as scripts/fetch-item-images.cjs: env > .dev.vars > wrangler.toml.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const API_DIR = path.join(__dirname, '..');
const BUCKET = 'record-docs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OPTS = {
  commit: flag('commit'),
  file: opt('file', 'C:/Users/emil_/Downloads/2026 Quote List(AutoRecovered).xlsx'),
  folders: opt('folders', 'C:/Users/emil_/Downloads/2026 Quotes'),
  only: opt('only', null),
  limit: parseInt(opt('limit', '0'), 10) || Infinity,
  maxParsePages: parseInt(opt('max-parse-pages', '10'), 10),
};
if (!OPTS.commit) console.log('*** DRY RUN — no DB writes, no uploads. Pass --commit to write. ***\n');

// ---------------------------------------------------------------------------
// Spreadsheet
// ---------------------------------------------------------------------------
function excelSerialToISODate(serial) {
  if (!serial || !Number.isFinite(Number(serial))) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(Number(serial)) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Header cells in this sheet carry stray leading/trailing spaces (e.g. " Quote Amount "). */
function trimmedKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k.trim()] = v;
  return out;
}

function readRows() {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(OPTS.file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '' }).map(trimmedKeys);
  return raw
    .map((r) => ({
      rep: String(r['Representative'] || '').trim(),
      jobName: String(r['Job Name'] || '').trim(),
      engineer: String(r['Engineer'] || '').trim(),
      amount: Number(r['Quote Amount']) || 0,
      txnDate: excelSerialToISODate(r['Date Quoted']),
      poDate: excelSerialToISODate(r['PO Received']),
    }))
    .filter((r) => r.jobName);
}

// ---------------------------------------------------------------------------
// Folder matching
// ---------------------------------------------------------------------------
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findFolder(jobName, foldersByNormalized) {
  const key = normalize(jobName);
  if (foldersByNormalized.has(key)) return foldersByNormalized.get(key);
  // Loose fallback: one side contains the other (handles trailing
  // disambiguators like "...Proton" or punctuation drift).
  for (const [normName, full] of foldersByNormalized) {
    if (normName.length > 4 && (key.includes(normName) || normName.includes(key))) return full;
  }
  return null;
}

function loadFolderIndex(root) {
  const map = new Map();
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    if (fs.statSync(full).isDirectory()) map.set(normalize(name), full);
  }
  return map;
}

/** Classifies every PDF in the folder as email vs quote. No primary-file guess here —
 * every file in this tree was synced down on the same day, so filename/mtime dates
 * are not trustworthy signals; see pickPrimaryByParsing below. */
function inspectFolder(folder) {
  const files = fs.readdirSync(folder).filter((f) => /\.pdf$/i.test(f));
  return files.map((f) => {
    const full = path.join(folder, f);
    return {
      fileName: f,
      fullPath: full,
      docType: /email/i.test(f) ? 'email' : 'quote',
      size: fs.statSync(full).size,
    };
  });
}

/**
 * Actually parses every quote-type PDF candidate and keeps whichever yields the
 * most line items — ground truth beats guessing from a filename. A folder often
 * has a short "D-NET" price-summary PDF alongside the full quote+submittals PDF;
 * only the latter has a Bill-of-Materials table to parse. Ties go to the larger
 * file (more pages => more likely the full submittal set).
 */
async function pickPrimaryByParsing(candidates, maxParsePages) {
  let best = null;
  let bestLines = [];
  for (const doc of candidates) {
    let lines = [];
    try {
      lines = await extractQuoteLines(doc.fullPath, maxParsePages);
    } catch (e) {
      console.log(`  ! PDF parse failed for "${doc.fileName}": ${e.message}`);
    }
    if (!best || lines.length > bestLines.length || (lines.length === bestLines.length && doc.size > best.size)) {
      best = doc;
      bestLines = lines;
    }
  }
  return { primary: best, lines: bestLines };
}

// ---------------------------------------------------------------------------
// PDF line-item parsing
// ---------------------------------------------------------------------------
const LINE_RE = /^(\d+)\s+(\S+)\s+(.+)$/;
const PRICE_TAIL_RE = /\s*([\d,]+\.\d{2})\$\s+([\d,]+\.\d{2})\$\s*$/;
// Marks the start of a Bill-of-Materials table — item rows are only trusted
// after this, never from page-header text above it (e.g. a street address
// like "330 W Jones Ave" would otherwise false-match as qty=330, item=W).
const TABLE_HEADER_RE = /Product Description\s+MOQ/i;
const TABLE_END_RE = /ALL ORDERS ARE PLUS FREIGHT|Refer to ["“]TBWC/i;

function parseLinesFromText(pageTexts) {
  const lines = [];
  for (const pageText of pageTexts) {
    let inTable = false;
    for (const raw of pageText.split('\n')) {
      const line = raw.trim();
      if (TABLE_HEADER_RE.test(line)) {
        inTable = true;
        continue;
      }
      if (TABLE_END_RE.test(line)) {
        inTable = false;
        continue;
      }
      if (!inTable) continue;
      const m = line.match(LINE_RE);
      if (!m) continue;
      const [, qtyStr, partNumber, restRaw] = m;
      const words = restRaw.trim().split(/\s+/);
      if (words.length < 2) continue; // filters page-footer noise like "2 OF 4"
      let rest = restRaw.trim();
      let rate = null;
      let amount = null;
      const priceMatch = rest.match(PRICE_TAIL_RE);
      if (priceMatch) {
        rate = Number(priceMatch[1].replace(/,/g, ''));
        amount = Number(priceMatch[2].replace(/,/g, ''));
        rest = rest.slice(0, priceMatch.index).trim();
      }
      lines.push({
        quantity: Number(qtyStr),
        itemName: partNumber,
        description: rest,
        rate,
        amount,
      });
    }
  }
  return lines;
}

async function extractQuoteLines(pdfPath, maxPages) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const bytes = fs.readFileSync(pdfPath);
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return parseLinesFromText(text.slice(0, maxPages));
}

// ---------------------------------------------------------------------------
// Supabase storage upload
// ---------------------------------------------------------------------------
async function uploadToBucket(objectPath, buf) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(objectPath)}`, {
    method: 'POST',
    headers: {
      ...(SERVICE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SERVICE_KEY}` } : { apikey: SERVICE_KEY }),
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const rows = readRows().filter((r) => !OPTS.only || r.jobName.toLowerCase().includes(OPTS.only.toLowerCase()));
  const folderIndex = loadFolderIndex(OPTS.folders);
  console.log(`${rows.length} spreadsheet rows, ${folderIndex.size} local folders found.\n`);

  let client = null;
  let alreadyImported = new Set();
  if (OPTS.commit) {
    client = new Client({ connectionString: DATABASE_URL, ssl: false });
    await client.connect();
    const existing = await client.query('SELECT DISTINCT job_name FROM public.quote WHERE job_name IS NOT NULL');
    alreadyImported = new Set(existing.rows.map((r) => r.job_name));
    console.log(`Resuming: ${alreadyImported.size} job_name(s) already in DB, will be skipped.\n`);
  }

  let imported = 0;
  let matchedFolders = 0;
  let totalLines = 0;
  let totalDocs = 0;

  for (const row of rows) {
    if (imported >= OPTS.limit) break;
    if (OPTS.commit && alreadyImported.has(row.jobName)) {
      console.log(`- ${row.jobName}  SKIP (already imported)\n`);
      continue;
    }
    const folder = findFolder(row.jobName, folderIndex);
    let docs = [];
    let primary = null;
    let parsedLines = [];
    if (folder) {
      matchedFolders++;
      docs = inspectFolder(folder);
      const candidates = docs.filter((d) => d.docType === 'quote');
      ({ primary, lines: parsedLines } = await pickPrimaryByParsing(candidates, OPTS.maxParsePages));
    }

    console.log(`- ${row.jobName}  [${row.rep || 'no rep'}]  $${row.amount}  ${row.txnDate || 'no date'}`);
    console.log(`  engineer=${row.engineer || '-'}  po_date=${row.poDate || '-'}`);
    if (folder) {
      console.log(`  folder: ${folder}`);
      console.log(`  docs: ${docs.map((d) => `${d.fileName} (${d.docType})`).join(', ') || 'none'}`);
      console.log(`  primary for line parse: ${primary ? primary.fileName : 'none'}`);
      console.log(`  parsed ${parsedLines.length} line(s)${parsedLines.length ? ':' : ''}`);
      for (const l of parsedLines.slice(0, 5)) {
        console.log(`    qty=${l.quantity}  item=${l.itemName}  rate=${l.rate ?? '-'}  amount=${l.amount ?? '-'}  desc=${l.description.slice(0, 70)}`);
      }
      if (parsedLines.length > 5) console.log(`    ...(${parsedLines.length - 5} more)`);
    } else {
      console.log(`  folder: NOT FOUND (header-only import)`);
    }
    console.log('');

    totalDocs += docs.length;
    totalLines += parsedLines.length;

    if (OPTS.commit) {
      await client.query('BEGIN');
      try {
        const insertRes = await client.query(
          `INSERT INTO public.quote
             (customer_list_id, customer_name, txn_date, total, sales_rep, status, job_name, engineer_name, po_date)
           VALUES (NULL, NULL, $1, $2, $3, 'quote', $4, $5, $6)
           RETURNING quote_id`,
          [row.txnDate, row.amount, row.rep || null, row.jobName, row.engineer || null, row.poDate]
        );
        const quoteId = insertRes.rows[0].quote_id;

        for (let i = 0; i < parsedLines.length; i++) {
          const l = parsedLines[i];
          await client.query(
            `INSERT INTO public.quote_line (quote_id, item_name, description, quantity, rate, amount, line_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [quoteId, l.itemName, l.description, l.quantity, l.rate || 0, l.amount || 0, i]
          );
        }

        for (const d of docs) {
          const buf = fs.readFileSync(d.fullPath);
          const objectPath = `quote/${quoteId}/${d.fileName}`;
          await uploadToBucket(objectPath, buf);
          await client.query(
            `INSERT INTO public.document
               (entity_type, entity_id, doc_type, file_name, mime_type, file_size, storage_bucket, storage_path)
             VALUES ('quote', $1, $2, $3, 'application/pdf', $4, $5, $6)`,
            [quoteId, d.docType, d.fileName, d.size, BUCKET, objectPath]
          );
        }

        await client.query('COMMIT');
        imported++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.log(`  ! COMMIT FAILED for "${row.jobName}": ${e.message}`);
      }
    } else {
      imported++;
    }
  }

  console.log(`\n${OPTS.commit ? 'Imported' : 'Would import'} ${imported} quote(s). ${matchedFolders} matched a local folder. ${totalDocs} document(s), ${totalLines} line item(s) total.`);

  if (client) await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
