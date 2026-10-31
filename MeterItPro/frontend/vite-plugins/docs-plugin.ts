/**
 * Vite plugin to serve the authored docs (cut sheets, guides) under /docs
 * without duplicating the files into public/.
 *
 * Single source of truth: MeterItPro/docs/application-sheet/
 *  - dev:   middleware maps GET /docs/* -> that folder
 *  - build: files are copied into dist/docs/*
 */

import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

// Source dir relative to the frontend package (Vite cwd)
const DOCS_SRC = path.resolve(process.cwd(), '../docs/application-sheet');
const URL_PREFIX = '/docs/';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
};

export function docsPlugin(): Plugin {
  return {
    name: 'docs-plugin',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(URL_PREFIX)) return next();
        // Strip query/hash, prevent path traversal
        const rel = decodeURIComponent(req.url.slice(URL_PREFIX.length).split('?')[0].split('#')[0]);
        if (rel.includes('..')) return next();
        const file = path.join(DOCS_SRC, rel);
        if (!file.startsWith(DOCS_SRC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return next();
        }
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },

    // Copy served docs into the build output
    closeBundle() {
      if (!fs.existsSync(DOCS_SRC)) return;
      const outDir = path.resolve(process.cwd(), 'dist/docs');
      fs.mkdirSync(outDir, { recursive: true });
      for (const name of fs.readdirSync(DOCS_SRC)) {
        const src = path.join(DOCS_SRC, name);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(outDir, name));
        }
      }
    },
  };
}
