/**
 * Emits MeterItPro-Application-Sheet-RevB.md from the same page sources the
 * HTML is built from, so the two cannot drift apart.
 *
 * This is a converter for exactly the markup used in src/pages*.html — it is
 * not a general HTML-to-Markdown tool. Add a branch when you add a component.
 *
 *   node src/to-markdown.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'MeterItPro-Application-Sheet-RevB.md');
const DOC_ID = 'MIP-AS-001';
const REV = 'Rev B';

const parts = fs.readdirSync(HERE)
  .filter((f) => /^pages.*\.html$/.test(f))
  .sort((a, b) => (a === 'pages.html' ? -1 : b === 'pages.html' ? 1 : a.localeCompare(b)));

const html = parts.map((f) => fs.readFileSync(path.join(HERE, f), 'utf8')).join('\n');

const ENT = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': ' ',
  '&thinsp;': ' ', '&middot;': '·', '&#39;': "'",
};
const text = (s) =>
  s.replace(/<b>(.*?)<\/b>/gs, '**$1**')
    .replace(/<br\s*\/?>/g, ' — ')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENT[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Inner contents of every <tag class="cls"> ... </tag>, matched with a depth
 * counter so nested tags of the same name do not close the match early.
 */
function grabAll(src, tag, cls) {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'g');
  const closeRe = new RegExp(`</${tag}>`, 'g');
  const found = [];

  for (const start of src.matchAll(new RegExp(`<${tag} class="${cls}"[^>]*>`, 'g'))) {
    let i = start.index + start[0].length;
    let depth = 1;
    while (depth > 0) {
      openRe.lastIndex = i;
      closeRe.lastIndex = i;
      const o = openRe.exec(src);
      const c = closeRe.exec(src);
      if (!c) break;
      if (o && o.index < c.index) {
        depth++;
        i = o.index + o[0].length;
      } else {
        depth--;
        i = c.index + c[0].length;
        if (depth === 0) found.push(src.slice(start.index + start[0].length, c.index));
      }
    }
  }
  return found;
}

/**
 * A .sec can hold several headed columns. Split it at each .sec-t so a column's
 * bullets stay under its own heading instead of piling onto the first one.
 */
function block(sec) {
  const out = [];
  const marks = [...sec.matchAll(/<div class="sec-t">([\s\S]*?)<\/div>/g)];

  if (!marks.length) return render(sec);

  if (marks[0].index > 0) out.push(...render(sec.slice(0, marks[0].index)));

  marks.forEach((m, i) => {
    const from = m.index + m[0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : sec.length;
    out.push(`### ${text(m[1])}`, '', ...render(sec.slice(from, to)), '');
  });

  return out;
}

function render(sec) {
  const out = [];

  // key figures
  for (const c of grabAll(sec, 'div', 'c')) {
    const big = c.match(/<div class="big">([\s\S]*?)<\/div>/);
    const lbl = c.match(/<div class="lbl">([\s\S]*?)<\/div>/);
    if (big && lbl) out.push(`- **${text(big[1])}** — ${text(lbl[1])}`);
  }

  // tag chips
  const tags = [...sec.matchAll(/<span class="tag(?: on)?">([\s\S]*?)<\/span>/g)].map((m) => text(m[1]));
  if (tags.length && !/<table/.test(sec)) out.push(tags.map((t) => `\`${t}\``).join(' · '));

  // capability / flow items
  for (const m of sec.matchAll(/<h4>([\s\S]*?)<\/h4>\s*<p>([\s\S]*?)<\/p>/g)) {
    out.push(`- **${text(m[1])}** — ${text(m[2])}`);
  }

  // definition lists
  for (const m of sec.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    out.push(`- **${text(m[1])}** — ${text(m[2])}`);
  }

  // numbered steps
  for (const m of sec.matchAll(/<span class="n">(\d+)<\/span><span class="d">([\s\S]*?)<\/span>/g)) {
    out.push(`${Number(m[1])}. ${text(m[2])}`);
  }

  // bullets
  for (const m of sec.matchAll(/<li>([\s\S]*?)<\/li>/g)) out.push(`- ${text(m[1])}`);

  // key/value spec rows
  const rows = [...sec.matchAll(/<span class="k">([\s\S]*?)<\/span><span class="v[^"]*">([\s\S]*?)<\/span>/g)];
  if (rows.length) {
    out.push('', '| Spec | Value |', '|------|-------|');
    for (const m of rows) out.push(`| ${text(m[1]) || '&nbsp;'} | ${text(m[2])} |`);
    out.push('');
  }

  // tables
  for (const t of sec.match(/<table>[\s\S]*?<\/table>/g) ?? []) {
    const head = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
    out.push('', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
    for (const tr of t.match(/<tr>(?:(?!<\/tr>)[\s\S])*<td[\s\S]*?<\/tr>/g) ?? []) {
      const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
      if (cells.length) out.push(`| ${cells.join(' | ')} |`);
    }
    out.push('');
  }

  // diagrams — carry the accessible description, which states the mechanism
  const dia = sec.match(/<svg class="diagram"[^>]*aria-label="([^"]*)"/);
  if (dia) out.push(`> _Diagram: ${text(dia[1])}._`);

  // body copy and captions
  for (const m of sec.matchAll(/<p class="body">([\s\S]*?)<\/p>/g)) out.push('', text(m[1]));
  for (const m of sec.matchAll(/<p class="cap">([\s\S]*?)<\/p>/g)) out.push('', `_${text(m[1])}_`);

  return out;
}

const pageRe = /<section class="page">([\s\S]*?)<\/section>/g;
const pages = [...html.matchAll(pageRe)].map((m) => m[1]);

const lines = [
  '# MeterIt Pro — Application Sheet',
  '',
  `**Electricity Meter Management** · Application Sheet  `,
  `Document: ${DOC_ID} · ${REV} · © ${new Date().getFullYear()} MeterIt Pro  `,
  'www.meteritpro.com | info@meteritpro.com',
  '',
  '> Generated from `src/pages*.html` by `src/to-markdown.mjs` — edit the sources,',
  '> not this file. Screenshots are embedded in the HTML build and appear here as',
  '> `_[screenshot: …]_` notes.',
  '',
];

pages.forEach((p, i) => {
  const n = String(i + 1).padStart(2, '0');
  const h = p.match(/<h2>([\s\S]*?)<\/h2>/);
  lines.push('---', '', `## Page ${n} — ${text(h?.[1] ?? '')}`, '');

  const dek = p.match(/<p class="dek">([\s\S]*?)<\/p>/);
  if (dek) lines.push(text(dek[1]), '');

  // page-level sections
  for (const sec of grabAll(p, 'div', 'sec')) lines.push(...block(sec), '');

  // screenshots
  for (const m of p.matchAll(/@@IMG:([\w-]+)@@/g)) {
    const cap = p.match(new RegExp(`@@IMG:${m[1]}@@[\\s\\S]*?<p class="cap">([\\s\\S]*?)</p>`));
    lines.push(`_[screenshot: ${cap ? text(cap[1]) : m[1]}]_`, '');
  }
});

const md = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
fs.writeFileSync(OUT, md, 'utf8');
console.log(`built ${path.basename(OUT)} — ${pages.length} pages, ${(md.length / 1024).toFixed(1)} KB`);
