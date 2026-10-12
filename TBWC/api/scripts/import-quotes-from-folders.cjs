#!/usr/bin/env node
/**
 * One-time bulk import: local job folders -> public.quote, plus every file
 * in each folder -> public.document (quote/email/workbook attachments) and
 * best-effort parsed Bill-of-Materials line items -> public.quote_line.
 *
 * Unlike scripts/import-quotes.cjs (spreadsheet-driven), this has NO
 * spreadsheet source: each top-level subfolder of --dir IS a job, named
 * after the job, and every header field is best-effort parsed out of the
 * job's own quote PDF(s) instead of coming from a spreadsheet row:
 *   - job_name   = folder name
 *   - txn_date   = latest MM/DD/YY date found in the cover-page header
 *   - sales_rep  = "NAME (email, phone)" pulled from the REPRESENTATIVE
 *                  block (name/email/phone print in varying order across
 *                  template revisions, so all three are hunted for
 *                  independently within that block rather than by position)
 *   - total      = max $-amount following a "D-NET PRICE:" / "TOTAL" label
 *                  (that max is always the grand total, since the lines
 *                  above it are components that sum to it) — stays 0 when
 *                  a folder's PDFs never print pricing on the cover page
 *   - memo       = POC + rep, so a later manual customer match has context
 * engineer_name/po_date have no equivalent in these folders and stay NULL.
 *
 * Every file in the folder (recursing into any nested subfolder — a
 * handful of jobs keep an old revision in one) is uploaded and attached as
 * a public.document row, not just PDFs: .msg emails, .xlsm/.xlsx price
 * workbooks, etc. Only quote-type PDFs (filename not matching /email/i) are
 * parsed for header fields + BOM lines; the candidate with the most parsed
 * lines is kept as "primary" for the BOM, same tie-break as
 * import-quotes.cjs. Header fields are parsed from EVERY quote-type PDF's
 * first page merged together (cheap — one page each) since which revision
 * prints pricing varies.
 *
 * Duplicate protection: a folder is skipped when its normalized name
 * exactly matches an existing public.quote.job_name (set by this script or
 * the earlier spreadsheet import) — most of these folders are already
 * imported. Exact match only, not loose/contains, because this folder tree
 * legitimately has distinct jobs sharing a prefix (e.g. "1625 Prince
 * Street" vs "1625 Prince Street Proton").
 *
 * Usage:
 *   node scripts/import-quotes-from-folders.cjs --dry-run                  # report only, no writes
 *   node scripts/import-quotes-from-folders.cjs --dry-run --only "Clinton" # one folder, for checking the parser
 *   node scripts/import-quotes-from-folders.cjs --commit                   # actually write + upload
 *   node scripts/import-quotes-from-folders.cjs --commit --limit 5         # write just the first 5 matched folders
 *
 * Config (DATABASE_URL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) resolves the
 * same way as scripts/import-quotes.cjs: env > .dev.vars > wrangler.toml.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { Agent, setGlobalDispatcher } = require('undici');

const API_DIR = path.join(__dirname, '..');
const BUCKET = 'record-docs';

// Some quote PDFs run 15-30MB; plain fetch's default undici headers timeout
// (~30s) fires while that body is still uploading over a slow link, well
// before Supabase ever responds. Raised, but capped well under 10 minutes —
// a run already hit a stalled upload (TCP connection stayed "established"
// with zero throughput) that sat idle for 8+ minutes before being killed by
// hand; a tighter bound lets a real stall fail and get picked back up by
// the caller's retry loop instead of hanging the whole run.
setGlobalDispatcher(new Agent({ headersTimeout: 120000, bodyTimeout: 120000 }));

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
  dir: opt('dir', 'C:/Users/emil_/Downloads/2026 Quotes'),
  only: opt('only', null),
  limit: parseInt(opt('limit', '0'), 10) || Infinity,
  maxParsePages: parseInt(opt('max-parse-pages', '10'), 10),
};
if (!OPTS.commit) console.log('*** DRY RUN — no DB writes, no uploads. Pass --commit to write. ***\n');

// ---------------------------------------------------------------------------
// Folder / file discovery
// ---------------------------------------------------------------------------
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function listJobFolders(root) {
  return fs
    .readdirSync(root)
    .filter((name) => fs.statSync(path.join(root, name)).isDirectory())
    .map((name) => ({ jobName: name.trim(), fullPath: path.join(root, name) }));
}

/** Recurses into any nested subfolder (a few jobs keep an old revision in one). */
function walkFiles(dir, relPrefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) {
      out.push(...walkFiles(full, rel));
    } else {
      out.push({ fullPath: full, relPath: rel, size: fs.statSync(full).size });
    }
  }
  return out;
}

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.msg': 'application/vnd.ms-outlook',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function classify(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  // public.document.doc_type is CHECK-constrained to a fixed list (migration
  // 047) with no "workbook"/spreadsheet value, so price workbooks land in
  // the catch-all 'other' alongside anything not explicitly a quote/email.
  let docType = 'other';
  if (ext === '.pdf') docType = /email/i.test(relPath) ? 'email' : 'quote';
  else if (ext === '.msg') docType = 'email';
  return { ext, mime, docType };
}

function inspectFolder(folder) {
  return walkFiles(folder).map((f) => ({ ...f, ...classify(f.relPath) }));
}

/**
 * Actually parses every quote-type PDF candidate and keeps whichever yields the
 * most line items — ground truth beats guessing from a filename. Ties go to
 * the larger file (more pages => more likely the full submittal set).
 */
async function pickPrimaryByParsing(candidates, maxParsePages) {
  let best = null;
  let bestLines = [];
  for (const doc of candidates) {
    let lines = [];
    try {
      lines = await extractQuoteLines(doc.fullPath, maxParsePages);
    } catch (e) {
      console.log(`  ! PDF parse failed for "${doc.relPath}": ${e.message}`);
    }
    if (!best || lines.length > bestLines.length || (lines.length === bestLines.length && doc.size > best.size)) {
      best = doc;
      bestLines = lines;
    }
  }
  return { primary: best, lines: bestLines };
}

// ---------------------------------------------------------------------------
// PDF line-item parsing (Bill-of-Materials table)
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

async function extractPdfPages(pdfPath, maxPages) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const bytes = fs.readFileSync(pdfPath);
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.slice(0, maxPages);
}

async function extractQuoteLines(pdfPath, maxPages) {
  return parseLinesFromText(await extractPdfPages(pdfPath, maxPages));
}

// ---------------------------------------------------------------------------
// Cover-page header parsing (date / rep / total / POC)
// ---------------------------------------------------------------------------
const NOISE_NAME_WORDS = /^(REPRESENTATIVE|PHONE|EMAIL ADDRESS|MOBILE|D-NET PRICE|TOTAL|UNIT AND PROJECT|PROJECT NOTES|BOM|TAKE-OFF)/i;

function parseHeaderBlock(text) {
  const header = {};

  const dateMatches = [...text.matchAll(/\b(\d{2})\/(\d{2})\/(\d{2})\b/g)];
  let latest = null;
  for (const [, mm, dd, yy] of dateMatches) {
    const iso = `20${yy}-${mm}-${dd}`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime()) && (!latest || iso > latest)) latest = iso;
  }
  if (latest) header.txnDate = latest;

  const poc = text.match(/POC:\s*([^\n]+)/i);
  if (poc) header.poc = poc[1].trim();

  const repIdx = text.search(/REPRESENTATIVE:/i);
  if (repIdx >= 0) {
    const block = text.slice(repIdx, repIdx + 500);
    const email = block.match(/[\w.+-]+@[\w.-]+\.\w+/);
    const phone = block.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    const nameLine = block
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 3 && !l.includes('@') && !l.includes(':') && !l.includes('$') && !/\d/.test(l) && !NOISE_NAME_WORDS.test(l));
    if (email) header.repEmail = email[0];
    if (phone) header.repPhone = phone[0];
    if (nameLine) header.repName = nameLine;
  }

  const priceIdx = text.search(/D-NET PRICE:|GRAND TOTAL|TOTAL PRICE/i);
  if (priceIdx >= 0) {
    const block = text.slice(priceIdx, priceIdx + 300);
    const amounts = [...block.matchAll(/([\d,]+\.\d{2})\$/g)].map((m) => Number(m[1].replace(/,/g, '')));
    if (amounts.length) header.total = Math.max(...amounts);
  }

  const engineer = text.match(/ENGINEER(?:ING)?\s*(?:OF RECORD)?:\s*([^\n]+)/i);
  if (engineer) header.engineerName = engineer[1].trim();

  return header;
}

function mergeHeaders(parts) {
  const merged = {};
  for (const h of parts) {
    for (const [k, v] of Object.entries(h)) {
      if (v == null) continue;
      if (k === 'txnDate') {
        if (!merged.txnDate || v > merged.txnDate) merged.txnDate = v;
      } else if (k === 'total') {
        if (!merged.total || v > merged.total) merged.total = v;
      } else if (merged[k] == null) {
        merged[k] = v;
      }
    }
  }
  return merged;
}

function buildSalesRep(header) {
  const parts = [];
  if (header.repName) parts.push(header.repName);
  const contact = [header.repEmail, header.repPhone].filter(Boolean).join(', ');
  if (contact) parts.push(`(${contact})`);
  return parts.join(' ') || null;
}

function buildMemo(header) {
  const parts = [];
  if (header.poc) parts.push(`POC: ${header.poc}`);
  const rep = buildSalesRep(header);
  if (rep) parts.push(`Rep: ${rep}`);
  parts.push('Imported from local job folder (no spreadsheet source).');
  return parts.join('  |  ');
}

// ---------------------------------------------------------------------------
// Supabase storage upload
// ---------------------------------------------------------------------------
async function uploadToBucket(objectPath, buf, mime) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(objectPath)}`, {
    method: 'POST',
    headers: {
      ...(SERVICE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SERVICE_KEY}` } : { apikey: SERVICE_KEY }),
      'Content-Type': mime,
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
  let folders = listJobFolders(OPTS.dir);
  if (OPTS.only) folders = folders.filter((f) => f.jobName.toLowerCase().includes(OPTS.only.toLowerCase()));
  console.log(`${folders.length} local job folder(s) found under ${OPTS.dir}.\n`);

  const client = new Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  const existing = await client.query('SELECT DISTINCT job_name FROM public.quote WHERE job_name IS NOT NULL');
  const existingNormalized = new Set(existing.rows.map((r) => normalize(r.job_name)));
  console.log(`${existingNormalized.size} job_name(s) already in DB — exact-normalized matches will be skipped.\n`);

  let imported = 0;
  let skipped = 0;
  let totalLines = 0;
  let totalDocs = 0;

  for (const { jobName, fullPath } of folders) {
    if (imported >= OPTS.limit) break;
    if (existingNormalized.has(normalize(jobName))) {
      skipped++;
      console.log(`- ${jobName}  SKIP (already imported)\n`);
      continue;
    }

    const docs = inspectFolder(fullPath);
    const quoteCandidates = docs.filter((d) => d.docType === 'quote');
    const { primary, lines: parsedLines } = await pickPrimaryByParsing(quoteCandidates, OPTS.maxParsePages);

    const headerParts = [];
    for (const doc of quoteCandidates) {
      try {
        const [page1] = await extractPdfPages(doc.fullPath, 1);
        if (page1) headerParts.push(parseHeaderBlock(page1));
      } catch (e) {
        console.log(`  ! header parse failed for "${doc.relPath}": ${e.message}`);
      }
    }
    const header = mergeHeaders(headerParts);
    const salesRep = buildSalesRep(header);
    const memo = buildMemo(header);

    console.log(`- ${jobName}`);
    console.log(`  txn_date=${header.txnDate || '-'}  total=${header.total ?? '-'}  rep=${salesRep || '-'}  poc=${header.poc || '-'}`);
    console.log(`  docs: ${docs.map((d) => `${d.relPath} (${d.docType})`).join(', ') || 'none'}`);
    console.log(`  primary for line parse: ${primary ? primary.relPath : 'none'}`);
    console.log(`  parsed ${parsedLines.length} line(s)${parsedLines.length ? ':' : ''}`);
    for (const l of parsedLines.slice(0, 5)) {
      console.log(`    qty=${l.quantity}  item=${l.itemName}  rate=${l.rate ?? '-'}  amount=${l.amount ?? '-'}  desc=${l.description.slice(0, 70)}`);
    }
    if (parsedLines.length > 5) console.log(`    ...(${parsedLines.length - 5} more)`);
    console.log('');

    totalDocs += docs.length;
    totalLines += parsedLines.length;

    if (OPTS.commit) {
      await client.query('BEGIN');
      try {
        const insertRes = await client.query(
          `INSERT INTO public.quote
             (customer_list_id, customer_name, txn_date, total, sales_rep, status, job_name, engineer_name, po_date, memo)
           VALUES (NULL, NULL, $1, $2, $3, 'quote', $4, $5, NULL, $6)
           RETURNING quote_id`,
          [header.txnDate || null, header.total || 0, salesRep, jobName, header.engineerName || null, memo]
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
          const objectPath = `quote/${quoteId}/${d.relPath}`;
          await uploadToBucket(objectPath, buf, d.mime);
          await client.query(
            `INSERT INTO public.document
               (entity_type, entity_id, doc_type, file_name, mime_type, file_size, storage_bucket, storage_path)
             VALUES ('quote', $1, $2, $3, $4, $5, $6, $7)`,
            [quoteId, d.docType, d.relPath, d.mime, d.size, BUCKET, objectPath]
          );
        }

        await client.query('COMMIT');
        imported++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.log(`  ! COMMIT FAILED for "${jobName}": ${e.message}`);
      }
    } else {
      imported++;
    }
  }

  console.log(
    `\n${OPTS.commit ? 'Imported' : 'Would import'} ${imported} quote(s). ${skipped} skipped as already-imported. ${totalDocs} document(s), ${totalLines} line item(s) total.`
  );

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
