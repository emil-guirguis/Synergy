# MeterIt Pro — Application Sheet

Product spec / cut sheet for MeterIt Pro (electricity meter management platform).

## Revisions

- **Rev B1** (`*-RevB.*`) — current, 13 pages. Built from `src/`. HTML and PDF
  only; see *Exporting* for why there is no `.docx` or Markdown. The revision
  stamp lives in `REV` in `src/build.mjs`; filenames stay `-RevB` so published
  links keep working across point revisions.
- **Rev A** (no suffix) — original 9-page issue, kept as an archive. Hand-authored
  HTML, no build step. Do not edit.

Both revisions are listed on the app's Documentation page
(`/support/documentations`). The Vite `docs-plugin` copies every *file* in this
folder into `dist/docs/`, so a format appears on the site as soon as it is
committed. Sub-directories (`src/`, `images/`) are skipped and stay out of the
deployed site.

## Building Rev B

```sh
node src/build.mjs        # -> MeterItPro-Application-Sheet-RevB.html
```

`src/` is the source of truth. Never edit the generated `.html` — it is
overwritten.

| Path | What it is |
|------|------------|
| `src/application-sheet.template.html` | Page shell and all CSS |
| `src/pages.html`, `src/pages-part2.html`, `src/pages-part3.html` | Page bodies, concatenated in filename order |
| `src/build.mjs` | Expands macros, inlines images, writes the HTML; holds `REV` and the alt text |
| `images/` | Screenshots and product photos, inlined at build time |
| `images/originals/` | Superseded versions, kept so a swap can be reverted |

Macros inside the page sources, each written as `@@NAME@@`:

- `BAND` — the navy header bar
- `FOOT` — the running footer; page numbers are counted automatically
- `IMG:<basename>` — inlines `images/<basename>.jpg` as a data URI, with alt text
  from the `ALT` map in `build.mjs`

The build fails loudly on an unexpanded macro, a missing image, or a page without
a footer — so a mistake never reaches the output silently.

## Page geometry — read before touching the CSS

Pages are authored at **true A4, 210 × 297 mm**, so the on-screen page and the
printed sheet are the same box and one section prints as exactly one sheet.

Rev A used `min-height: 1180px`, which is taller than A4's 1123px at 96dpi. Every
page therefore spilled onto a second sheet and its 9 pages printed as 13. Do not
reintroduce a pixel page height.

A section that outgrows 297 mm is **clipped, not reflowed**. To check every page
still fits, load the built HTML and measure the gap under each page's last block:

```js
document.querySelectorAll('.page').forEach((p, i) => {
  const c = p.querySelector('.content');
  const pad = parseFloat(getComputedStyle(c).paddingBottom);
  const free = c.getBoundingClientRect().bottom - pad
             - c.lastElementChild.getBoundingClientRect().bottom;
  console.log(i + 1, Math.round(free));   // negative means content is being cut off
});
```

`.page` carries `page-break-after` *outside* the print media query on purpose:
Word reads screen CSS only, and that rule is what keeps the `.docx` export from
reflowing into extra pages. It is inert in a browser on screen.

## Exporting

**PDF** — headless Chrome, exact at 13 sheets:

```sh
chrome --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="MeterItPro-Application-Sheet-RevB.pdf" \
  "file:///ABSOLUTE/PATH/MeterItPro-Application-Sheet-RevB.html"
```

**Word** — Rev B ships no `.docx`, deliberately. Word's HTML import is a
converter, not a renderer: it has no support for `display:flex` or `grid` (this
layout is flex throughout), ignores mm-precise fixed heights, and rebuilds the
content as Word paragraphs and tables. The result never matches the HTML — that
is Word, not the reader's viewer. Rev A's `.docx` is kept only as an archive.

Send the PDF when a fixed layout matters, or the HTML when it does not.

**Markdown** — dropped for Rev B1. It could not carry the diagrams, the spec
blocks or the page structure, so it read as a lossy summary of the real
document rather than a second edition of it.

## Screenshots

Images are inlined as base64 in the built HTML, so the file opens offline with no
external assets. To replace one, drop a new file over `images/<name>.<ext>` and
re-run the build — there is no need to hand-edit a data URI. Keep only one file
per basename; the build takes the first match.

Watch the file size. A product photo saved as a transparent PNG cost 617 KB where
a JPEG composited onto the panel background costs 28 KB and looks identical,
because `.panel` is a flat colour. Nothing here renders larger than about 50 mm.
