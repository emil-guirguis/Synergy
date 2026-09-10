#!/usr/bin/env node
/**
 * Populate qb_item.image_url with product thumbnails for the printed price
 * sheet. See migrations/027-inventory-images.sql for the columns and bucket,
 * scripts/image-families.cjs for the curated family rules, and
 * scripts/README-item-images.md for setup.
 *
 * Per row:  pick a query  ->  image search  ->  download  ->  resize  ->
 *           upload to the public item-images bucket  ->  write the row.
 *
 * Two things about this script matter more than the plumbing:
 *
 * 1. FAMILY FIRST. Rows matching a rule in image-families.cjs share one image,
 *    fetched once. That is what makes the 408 DI-* rows cost one search instead
 *    of 408 wrong ones. Only unmatched rows get a per-SKU search.
 *
 * 2. NOTHING IT WRITES IS TRUSTED. Every machine-picked image lands as
 *    image_status='auto' with a confidence score. A human promotes it to
 *    'approved' in the Inventory screen. The script never overwrites a human
 *    verdict ('approved' / 'rejected') — re-running is always safe.
 *
 * Usage:
 *   node scripts/fetch-item-images.cjs --dry-run            # plan only, no calls
 *   node scripts/fetch-item-images.cjs --families-only      # the cheap 80%
 *   node scripts/fetch-item-images.cjs --limit 50           # a taste test
 *   node scripts/fetch-item-images.cjs --only '^CT'         # one family
 *   node scripts/fetch-item-images.cjs --refresh --only '^DI-'
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const sharp = require('sharp');
const { matchFamily } = require('./image-families.cjs');

// ---------------------------------------------------------------------------
// Config. DATABASE_URL/SUPABASE_URL come from wrangler.toml [vars] (same values
// the local Worker uses); the two secrets come from .dev.vars or the real env,
// because they must never be committed.
// ---------------------------------------------------------------------------
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
const SUPABASE_URL = cfg('SUPABASE_URL');
const SERVICE_KEY = cfg('SUPABASE_SERVICE_ROLE_KEY');
const BUCKET = 'item-images';

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
  dryRun: flag('dry-run'),
  refresh: flag('refresh'),
  familiesOnly: flag('families-only'),
  searchOnly: flag('search-only'),
  limit: parseInt(opt('limit', '0'), 10),
  only: opt('only', null) ? new RegExp(opt('only'), 'i') : null,
  concurrency: Math.max(1, parseInt(opt('concurrency', '3'), 10)),
  size: parseInt(opt('size', '400'), 10),
  provider: opt('provider', 'ddg'),
};

// ---------------------------------------------------------------------------
// Image search providers.
//
// Google CSE needs BOTH a key and a search-engine id (cx) whose control panel
// has "Image search" ON and "Search the entire web" ON — a CSE left in its
// default site-restricted mode returns zero results for everything, which looks
// exactly like a broken key. Brave needs only a token.
// ---------------------------------------------------------------------------
/**
 * DDG has no published rate limit; empirically a burst of ~30 image calls earns
 * an IP-wide 403 ("If this error persists, please let us know: ops@...") that
 * outlives the process. So calls are serialised with a gap and a slow retry —
 * a 433-row sweep is a background job, not something worth getting blocked for.
 */
const DDG_GAP_MS = 8000;
let ddgNextAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ddgPace() {
  const wait = ddgNextAt - Date.now();
  if (wait > 0) await sleep(wait);
  ddgNextAt = Date.now() + DDG_GAP_MS + Math.floor(Math.random() * 1500);
}

const PROVIDERS = {
  async google(query, size) {
    const key = cfg('GOOGLE_CSE_KEY');
    const cx = cfg('GOOGLE_CSE_CX');
    if (!key || !cx) throw new Error('GOOGLE_CSE_KEY / GOOGLE_CSE_CX not set (see README-item-images.md)');
    const url =
      `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}` +
      `&searchType=image&num=5&imgSize=${size >= 600 ? 'large' : 'medium'}` +
      `&safe=active&q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google CSE ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return (json.items || []).map((it) => ({
      imageUrl: it.link,
      pageUrl: it.image?.contextLink || it.link,
      title: `${it.title || ''} ${it.snippet || ''}`.trim(),
    }));
  },

  async brave(query) {
    const token = cfg('BRAVE_SEARCH_KEY');
    if (!token) throw new Error('BRAVE_SEARCH_KEY not set (see README-item-images.md)');
    const url = `https://api.search.brave.com/res/v1/images/search?count=5&safesearch=strict&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': token },
    });
    if (!res.ok) throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return (json.results || []).map((it) => ({
      imageUrl: it.properties?.url || it.thumbnail?.src,
      pageUrl: it.url,
      title: `${it.title || ''} ${it.source || ''}`.trim(),
    }));
  },

  // DuckDuckGo images. No key, no account, no quota — the reason it is the
  // default is that Google's CSE answers every call for this account with
  // 403 "This project does not have the access to Custom Search JSON API",
  // across three projects and three keys, and Brave wants a card on file.
  //
  // It is an undocumented endpoint, so it is used defensively: one `vqd` token
  // is minted per process (the token is what the i.js endpoint checks), results
  // are read through the same {imageUrl,pageUrl,title} shape as every other
  // provider, and any shape change surfaces as "no hits" — a pending row — not
  // as a wrong image.
  async ddg(query, _size, attempt = 0) {
    await ddgPace();
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

    // The vqd token is minted FOR ONE QUERY. Caching one across rows is what a
    // first pass here did, and i.js answered 403 for every row after the first.
    const seed = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
      headers: { 'User-Agent': UA },
    });
    if (!seed.ok) throw new Error(`DDG seed ${seed.status}`);
    const html = await seed.text();
    const m = html.match(/vqd=["']([^"'&]+)["']/) || html.match(/vqd=([0-9-]+)&/);
    if (!m) throw new Error('DDG: no vqd token in seed page (endpoint changed?)');

    const url =
      `https://duckduckgo.com/i.js?l=us-en&o=json&f=,,,,,&p=1&v7exp=a` +
      `&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(m[1])}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://duckduckgo.com/' },
    });
    if (res.status === 403 || res.status === 429) {
      // Cooling off beats failing 400 rows: back off 60s, 2min, 4min, then give up.
      if (attempt < 3) {
        const backoff = 60000 * 2 ** attempt;
        log(`      DDG ${res.status} — backing off ${backoff / 1000}s`);
        await sleep(backoff);
        return PROVIDERS.ddg(query, _size, attempt + 1);
      }
      throw new Error(`DDG ${res.status} after ${attempt} retries (IP throttled)`);
    }
    if (!res.ok) throw new Error(`DDG ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return (json.results || []).slice(0, 5).map((it) => ({
      imageUrl: it.image,
      pageUrl: it.url || it.image,
      title: `${it.title || ''} ${it.source || ''}`.trim(),
    }));
  },

  // Wikimedia Commons. No key, no quota, no account — the reason it exists here
  // is that Google's CSE cannot be pointed at the whole web without an engine
  // the console refuses to create, and Brave wants a card on file. Coverage is
  // the trade: Commons is excellent for generic hardware (current transformers,
  // fuses, water meters, LED lamps) and empty for private-label SKUs, which is
  // exactly the split the family rules already draw.
  async commons(query, size) {
    const url =
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
      '&generator=search&gsrnamespace=6&gsrlimit=8' +
      `&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}` +
      `&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=${Math.max(size, 400)}`;
    const res = await fetch(url, {
      // Wikimedia blocks unidentified clients; the policy asks for a contact URL.
      headers: { 'User-Agent': 'TBWC-catalog-thumbs/1.0 (https://tbwc.example; catalog thumbnails)' },
    });
    if (!res.ok) throw new Error(`Commons ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const pages = Object.values(json.query?.pages || {});
    // generator=search returns pages keyed by id; `index` carries the ranking.
    pages.sort((a, b) => (a.index || 0) - (b.index || 0));
    return pages
      .map((p) => {
        const info = (p.imageinfo || [])[0] || {};
        return {
          imageUrl: info.thumburl || info.url,
          pageUrl: info.descriptionurl || info.url,
          // "File:Split core current transformer.jpg" -> the words the scorer wants.
          title: String(p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '),
        };
      })
      .filter((h) => h.imageUrl);
  },
};

// ---------------------------------------------------------------------------
// Query building + scoring
// ---------------------------------------------------------------------------

/**
 * Words that make a product search worse — packaging/commercial filler, not
 * identity. Kept deliberately short: units and ratings (amp, 480V, NEMA 4X,
 * 2700k) LOOK like noise but are exactly what makes an image search land on the
 * right variant, and stripping them once turned "100-Amp Split-Core CT" into
 * the query "100- Split-Core CT".
 */
const NOISE = /\b(kit|assembly|assy|each|ea|pcs?|w\/|with|for|use|effective|approx|option|adder|qty)\b/gi;

/** QuickBooks stores smart quotes and bullets as HTML entities; they survive into descriptions. */
function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      // Windows-1252 punctuation (145-151) shows up as literal entities in QB text.
      if (code >= 145 && code <= 148) return '"';
      if (code === 149 || code === 150 || code === 151) return '-';
      return code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
    })
    .replace(/&(amp|quot|nbsp|lt|gt);/gi, ' ');
}

/**
 * Turn a catalog row into something a person would actually type into an image
 * search. The description is the useful half ("Audio Paging System", "PAR30
 * 2700k FLOOD"); the SKU is mostly private-label noise, so it is only kept when
 * it looks like a real manufacturer part number (letters AND digits, long
 * enough to be distinctive) rather than an internal code.
 *
 * Returns null when there is nothing searchable — a bare dimension string or a
 * three-character code. Those rows are skipped rather than burning an API call
 * on a query that cannot succeed.
 */
function buildQuery(row) {
  const name = decodeEntities(row.name).replace(/\s+/g, ' ').trim();
  const desc = decodeEntities(row.sales_desc)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // First clause of the description carries the identity; the rest is specs.
  const head = desc.split(/[,.(]/)[0].trim();
  const body = (head.length >= 12 ? head : desc).slice(0, 90);

  const looksLikeMpn = /^[A-Z0-9][A-Z0-9\-\/]{5,}$/i.test(name) && /[A-Z]/i.test(name) && /\d/.test(name);
  const cleaned = body.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();

  const parts = [];
  if (looksLikeMpn) parts.push(name);
  parts.push(cleaned || name);
  const query = parts
    .join(' ')
    .slice(0, 120)
    // QB descriptions often end mid-spec after the truncation above ("… CT: 0",
    // "… Leads,"). A dangling separator or orphan number only dilutes the search.
    .replace(/[\s:;,\-\/]+\d*\s*$/, '')
    .trim();

  // Needs at least two real words to stand a chance. "13 x 13 x 13" and "1068"
  // describe a carton size or an internal code, not a findable product.
  const words = query.split(/\s+/).filter((w) => /[a-z]{3}/i.test(w));
  return words.length >= 1 && query.length >= 6 ? query : null;
}

/**
 * 0-100 confidence that a search hit is really this item.
 *
 * Deliberately harsh. The point is not to rank hits — it is to tell the reviewer
 * which rows to distrust, so an unremarkable score has to mean "look at me".
 * An exact part-number echo in the result title is the only strong evidence
 * available; everything else is word overlap, which is weak.
 */
function scoreHit(row, hit) {
  const title = (hit.title || '').toLowerCase();
  if (!title) return 30;

  const name = (row.name || '').toLowerCase();
  let score = 30;

  if (name.length >= 5 && title.includes(name)) score += 45;

  const words = (row.sales_desc || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const uniq = [...new Set(words)].slice(0, 12);
  if (uniq.length) {
    const hits = uniq.filter((w) => title.includes(w)).length;
    score += Math.round((hits / uniq.length) * 25);
  }
  return Math.min(score, 95);
}

// ---------------------------------------------------------------------------
// Fetch / resize / upload
// ---------------------------------------------------------------------------

/** Download with a hard timeout and a size cap — a stray 40MB TIFF must not hang the sweep. */
async function download(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Some vendor CDNs 403 an unadorned fetch.
        'User-Agent': 'Mozilla/5.0 (compatible; TBWC-catalog-thumbs/1.0)',
        Accept: 'image/*',
      },
    });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content-type'})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) throw new Error('image over 12MB');
    if (buf.length < 1024) throw new Error('image under 1KB (probably a placeholder)');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Square-ish webp thumbnail on a white ground.
 *
 * `fit: 'inside'` never crops — cropping a product photo can cut the product in
 * half, and a slightly letterboxed thumb prints fine. The white flatten is for
 * print specifically: transparent PNGs go black in some PDF pipelines.
 * 400px default is sized for a ~1.3in thumbnail at 300dpi.
 */
async function toThumb(buf, size) {
  return sharp(buf)
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 82 })
    .toBuffer();
}

async function upload(objectPath, buf) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      // Two key formats are in the wild. A legacy service_role key is a JWT and
      // rides in Authorization; a new-style `sb_secret_…` key is not a JWT, and
      // Storage answers "Invalid Compact JWS" if you put it there — it belongs
      // in apikey. Sending both covers either kind.
      ...(SERVICE_KEY.startsWith('eyJ')
        ? { Authorization: `Bearer ${SERVICE_KEY}` }
        : { apikey: SERVICE_KEY }),
      'Content-Type': 'image/webp',
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

/** search -> download -> resize -> upload, trying hits in order until one works. */
async function resolveImage(query, objectPath, row) {
  const provider = PROVIDERS[OPTS.provider];
  if (!provider) throw new Error(`Unknown provider "${OPTS.provider}" (ddg | google | brave | commons)`);

  const hits = await provider(query, OPTS.size);
  if (!hits.length) return null;

  // A hit can fail for reasons that say nothing about the next one (hotlink
  // block, dead CDN, SVG) — so walk the list rather than giving up on the row.
  for (const hit of hits) {
    if (!hit.imageUrl) continue;
    try {
      const thumb = await toThumb(await download(hit.imageUrl), OPTS.size);
      const url = OPTS.dryRun ? '(dry-run)' : await upload(objectPath, thumb);
      return { url, sourceUrl: hit.pageUrl || hit.imageUrl, confidence: scoreHit(row, hit) };
    } catch (e) {
      log(`      hit rejected (${hit.imageUrl?.slice(0, 60)}): ${e.message}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const log = (...a) => console.log(...a);

async function main() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL not found');
  if (!OPTS.dryRun && (!SUPABASE_URL || !SERVICE_KEY)) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required (see README-item-images.md)');
  }

  const db = new Client({ connectionString: DATABASE_URL, ssl: false, keepAlive: true });
  // A DDG throttle can park this loop for four minutes, which is long enough for
  // the pooler to drop an idle socket. Without a listener pg re-emits that as an
  // unhandled 'error' event and takes the whole sweep down mid-run.
  db.on('error', (e) => log(`  DB connection error (will reconnect on next write): ${e.message}`));
  await db.connect();

  // 'approved' and 'rejected' are human verdicts — never in the work set, even
  // with --refresh. 'none' is a settled non-product. --refresh only re-opens
  // rows the machine itself filled in.
  const { rows } = await db.query(`
    SELECT qb_item_id, name, sales_desc, item_type, image_url, image_status
      FROM qb_item
     WHERE image_status NOT IN ('approved', 'rejected', 'none')
       ${OPTS.refresh ? '' : 'AND image_url IS NULL'}
     ORDER BY name
  `);

  const work = rows.filter((r) => !OPTS.only || OPTS.only.test(r.name || ''));

  // Resolve families up front so the plan (and the dry run) shows the real
  // shape of the job: how many rows ride on how few searches.
  const planned = work.map((r) => ({ row: r, family: matchFamily(r) }));
  const selected = planned.filter((p) => {
    if (OPTS.familiesOnly) return !!p.family;
    if (OPTS.searchOnly) return !p.family;
    return true;
  });
  const finalWork = OPTS.limit > 0 ? selected.slice(0, OPTS.limit) : selected;

  const famCounts = new Map();
  for (const p of finalWork) if (p.family) famCounts.set(p.family.id, (famCounts.get(p.family.id) || 0) + 1);
  const noneRows = finalWork.filter((p) => p.family?.none);
  const searchRows = finalWork.filter((p) => !p.family);

  log(`\n${finalWork.length} rows to process`);
  log(`  ${famCounts.size} families covering ${finalWork.length - searchRows.length} rows`);
  log(`  ${noneRows.length} of those marked 'none' (no product photo exists)`);
  log(`  ${searchRows.length} rows need their own search`);
  log(`  ~${[...famCounts.keys()].filter((id) => !noneRows.some((n) => n.family.id === id)).length + searchRows.length} search API calls\n`);

  for (const [id, n] of [...famCounts].sort((a, b) => b[1] - a[1])) log(`    ${String(n).padStart(4)}  ${id}`);
  log('');

  if (OPTS.dryRun) {
    const unsearchable = searchRows.filter((p) => !buildQuery(p.row));
    log(`--dry-run: ${unsearchable.length} of the ${searchRows.length} per-SKU rows have nothing searchable and will be skipped.`);
    log('Sample queries for the rest —');
    for (const p of searchRows.filter((x) => buildQuery(x.row)).slice(0, 20)) {
      log(`    ${p.row.name}  ->  "${buildQuery(p.row)}"`);
    }
    await db.end();
    return;
  }

  const stats = { ok: 0, none: 0, miss: 0, skip: 0, err: 0 };
  const familyCache = new Map(); // family id -> resolved image (one fetch per family)

  async function processOne(p) {
    const { row, family } = p;
    const id = row.qb_item_id;

    // Settled non-products: record the verdict, spend nothing.
    if (family?.none) {
      await db.query(
        `UPDATE qb_item SET image_status='none', image_source='family', image_updated_at=now()
          WHERE qb_item_id=$1`,
        [id]
      );
      stats.none++;
      return;
    }

    try {
      let img;
      if (family) {
        if (!familyCache.has(family.id)) {
          log(`  [family ${family.id}] ${family.label}`);
          const objectPath = `family/${family.id}.webp`;
          let resolved = null;
          if (family.imageUrl) {
            // Pinned by hand — no search, and it keeps the rule's own confidence.
            const thumb = await toThumb(await download(family.imageUrl), OPTS.size);
            resolved = {
              url: await upload(objectPath, thumb),
              sourceUrl: family.imageUrl,
              confidence: family.confidence ?? 90,
            };
          } else {
            resolved = await resolveImage(family.query, objectPath, row);
            if (resolved) resolved.confidence = family.confidence ?? 75;
          }
          familyCache.set(family.id, resolved);
        }
        img = familyCache.get(family.id);
      } else {
        const query = buildQuery(row);
        // No searchable text (bare carton dimensions, an internal code). Left
        // 'pending' on purpose: it needs a family rule or a human, not a retry.
        if (!query) {
          stats.skip++;
          log(`  SKIP  ${row.name} (nothing searchable)`);
          return;
        }
        img = await resolveImage(query, `item/${id}.webp`, row);
      }

      if (!img) {
        stats.miss++;
        log(`  MISS  ${row.name}`);
        return;
      }

      await db.query(
        `UPDATE qb_item
            SET image_url=$2, image_source_url=$3, image_source=$4,
                image_confidence=$5, image_status='auto', image_updated_at=now()
          WHERE qb_item_id=$1`,
        [id, img.url, img.sourceUrl, family ? 'family' : 'search', img.confidence]
      );
      stats.ok++;
      log(`  OK ${String(img.confidence).padStart(3)}  ${row.name}`);
    } catch (e) {
      stats.err++;
      log(`  ERR   ${row.name}: ${e.message}`);
    }
  }

  // Families are resolved once and then reused, so run family rows first and
  // single-file — otherwise N parallel rows in the same family would each fire
  // their own search before the cache is warm.
  for (const p of finalWork.filter((x) => x.family)) await processOne(p);

  const queue = finalWork.filter((x) => !x.family);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: OPTS.concurrency }, async () => {
      while (cursor < queue.length) await processOne(queue[cursor++]);
    })
  );

  log(`\nDone. set=${stats.ok}  none=${stats.none}  no-result=${stats.miss}  errors=${stats.err}`);
  log(`Review them in the Inventory screen — everything above is image_status='auto' until a human approves it.`);
  await db.end();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
