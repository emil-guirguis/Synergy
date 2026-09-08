/**
 * Vite plugin: emit dist/404.html for GitHub Pages — but NOT a plain copy of
 * dist/index.html, because this site hosts TWO SPAs (MeterItPro at the site
 * root, TBWC merged in afterward under /TBWCPortal/ — see deploy-gh-pages.yml).
 * GitHub Pages only supports one 404.html per site, so a deep link under
 * /TBWCPortal/* (e.g. /Synergy/TBWCPortal/orders) 404s and falls back to this
 * SAME file. A plain copy of MeterItPro's index.html booted the WRONG app for
 * those paths and crashed (MeterItPro's router trying to interpret a TBWC
 * route shape). Found + logged 2026-09-07, fixed same day.
 *
 * Fix: 404.html is a tiny dispatcher, not either app's real index.html. It
 * inspects location.pathname (which GitHub Pages leaves untouched — only the
 * served body changes), fetches the CORRECT app's actual index.html content,
 * and writes it into the document. Neither app needs any routing changes:
 * whichever app boots sees the same location.pathname it would have seen from
 * a real page load at that path, so its own router matches normally.
 *
 * Only runs for a non-root base (GitHub Pages). Cloudflare Pages (base '/')
 * uses public/_redirects (`/* /index.html 200`) instead — a 404.html there
 * would take priority over that 200 rewrite, so this is skipped for base '/'.
 */

import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

export function spaFallbackPlugin(): Plugin {
  let base = '/';
  return {
    name: 'spa-fallback-plugin',
    // Run after other closeBundle hooks so index.html is already written.
    enforce: 'post',
    configResolved(config) {
      base = config.base;
    },
    closeBundle() {
      // Root base = Cloudflare (uses _redirects → 200). Only GitHub Pages
      // (non-root base) needs the 404.html fallback.
      if (base === '/' || base === './') {
        console.log('🧭 spa-fallback: root base — skipping 404.html (Cloudflare uses _redirects)');
        return;
      }
      const distDir = path.resolve(process.cwd(), 'dist');
      const index = path.join(distDir, 'index.html');
      const fallback = path.join(distDir, '404.html');
      if (!fs.existsSync(index)) return;

      const tbwcBase = `${base}TBWCPortal/`;
      const dispatcher = `<!doctype html>
<html><head><meta charset="utf-8"><title>Loading…</title></head>
<body><script>
  (function () {
    var path = window.location.pathname;
    var target = path.indexOf(${JSON.stringify(tbwcBase)}) === 0
      ? ${JSON.stringify(tbwcBase + 'index.html')}
      : ${JSON.stringify(base + 'index.html')};
    fetch(target).then(function (r) { return r.text(); }).then(function (html) {
      document.open();
      document.write(html);
      document.close();
    });
  })();
</script></body></html>
`;
      fs.writeFileSync(fallback, dispatcher);
      console.log(`🧭 spa-fallback: wrote dispatcher dist/404.html (base ${base}, tbwc prefix ${tbwcBase})`);
    },
  };
}
