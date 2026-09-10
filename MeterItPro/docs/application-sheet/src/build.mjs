/**
 * Builds MeterItPro-Application-Sheet-RevB.html from:
 *   src/application-sheet.template.html   shell + all CSS
 *   src/pages*.html                       page bodies, in filename order
 *   images/*                              screenshots and product photos,
 *                                         inlined as data URIs
 *
 * The output is a single self-contained file — no external assets — so it opens
 * offline and prints identically anywhere. Edit the sources, never the output.
 *
 *   node src/build.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'MeterItPro-Application-Sheet-RevB.html');

const DOC_ID = 'MIP-AS-001';
const REV = 'Rev B1';
const YEAR = new Date().getFullYear();

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** Alt text per image, so the output stays accessible and searchable. */
const ALT = {
  '01-home-dashboard': 'MeterIt Pro portfolio home with energy today, peak demand, active meters and open alerts, plus recent activity and favourites',
  '02-meters-list': 'Meter list showing physical and virtual meters with device model, IP address, sync server and live status',
  '03-meter-readings': 'Register readings table with kWh, calculated kWh, kVA, per-phase kVA and per-phase amperage at 15-minute intervals',
  '04-custom-dashboard': 'Custom dashboard with a Peak kW chart and its range, chart type, granularity and aggregation controls',
  '05-notification-rules': 'Notification rules list showing custom, no-reading and zero-reading rule types with active toggles',
  '06-zenith-ai': 'Zenith AI assistant with suggested questions about meters, readings and alerts',
  '07-syncserver-front': 'Dell micro desktop front and side, showing power button, audio jack, USB-A and USB-C ports',
  '08-syncserver-rear': 'Dell micro desktop rear I/O with Gigabit Ethernet, USB, dual DisplayPort and HDMI',
  '09-enclosure': 'Integra H161407HLL light grey polycarbonate enclosure with a hinged opaque cover, two stainless steel locking latches and a mounting foot kit',
};

function dataUri(base) {
  const dir = path.join(ROOT, 'images');
  const hit = fs.readdirSync(dir).find((f) => path.parse(f).name === base && MIME[path.extname(f).toLowerCase()]);
  if (!hit) throw new Error(`No image for @@IMG:${base}@@ in ${dir}`);
  const ext = path.extname(hit).toLowerCase();
  const b64 = fs.readFileSync(path.join(dir, hit)).toString('base64');
  return `<img src="data:${MIME[ext]};base64,${b64}" alt="${ALT[base] ?? base}" />`;
}

const BAND = `<div class="band">
    <div class="mark">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="12" width="4" height="8" fill="#fff"/><rect x="10" y="7" width="4" height="13" fill="#fff" opacity=".85"/><rect x="17" y="3" width="4" height="17" fill="#fff" opacity=".7"/></svg>
      <div class="nm">MeterIt&nbsp;Pro<small>Cloud Platform</small></div>
    </div>
    <div class="kicker">
      <div class="k1">Electricity Meter Management</div>
      <div class="k2">Application Sheet · ${DOC_ID} · ${REV}</div>
    </div>
  </div>`;

const foot = (n, total) => `<div class="foot">
    <span>${DOC_ID} · ${REV} · © ${YEAR} MeterIt Pro</span>
    <span class="mid">${n} / ${total}</span>
    <span>meteritpro.com · info@meteritpro.com</span>
  </div>`;

// --- assemble page bodies, in filename order (pages.html, pages-part2.html, ...) ---
const parts = fs
  .readdirSync(HERE)
  .filter((f) => /^pages.*\.html$/.test(f))
  .sort((a, b) => (a === 'pages.html' ? -1 : b === 'pages.html' ? 1 : a.localeCompare(b)));

let pages = parts.map((f) => fs.readFileSync(path.join(HERE, f), 'utf8')).join('\n');

const total = (pages.match(/<section class="page">/g) ?? []).length;
if (!total) throw new Error('No <section class="page"> found in the page sources');

let n = 0;
pages = pages
  .replace(/@@BAND@@/g, () => BAND)
  .replace(/@@FOOT@@/g, () => foot(++n, total))
  .replace(/@@IMG:([\w-]+)@@/g, (_, base) => dataUri(base));

const leftover = pages.match(/@@[A-Z]+[^@]*@@/g);
if (leftover) throw new Error(`Unexpanded macros: ${[...new Set(leftover)].join(', ')}`);
if (n !== total) throw new Error(`${total} pages but ${n} footers — every page needs one @@FOOT@@`);

const template = fs.readFileSync(path.join(HERE, 'application-sheet.template.html'), 'utf8');
fs.writeFileSync(OUT, template.replace('@@PAGES@@', pages), 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`built ${path.relative(ROOT, OUT)} — ${total} pages, ${kb} KB`);
