/**
 * Post-build prerender script.
 * Spins up a local static server, visits each public route with headless Chrome,
 * and writes the rendered HTML to dist/ so bots (Bing, LinkedIn, etc.) get full content.
 *
 * Run via: npm run postbuild  (called automatically after `npm run build`)
 */
import puppeteer from 'puppeteer';
import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import handler from 'serve-handler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '../dist');
const PORT = 5099;

// Public routes to prerender
const ROUTES = ['/', '/login', '/signup'];

function startServer() {
  return new Promise((res) => {
    const server = createServer((req, reply) => {
      handler(req, reply, {
        public: distDir,
        rewrites: [{ source: '**', destination: '/index.html' }],
      });
    });
    server.listen(PORT, () => res(server));
  });
}

async function prerenderRoute(browser, route) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
  await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: 'networkidle0', timeout: 30000 });
  // Wait for React to render
  await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
  const html = await page.content();
  await page.close();
  return html;
}

async function main() {
  let server;
  let browser;
  try {
    server = await startServer();
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    for (const route of ROUTES) {
      process.stdout.write(`  Rendering ${route} ... `);
      const html = await prerenderRoute(browser, route);
      const outDir = resolve(distDir, route === '/' ? '' : route.slice(1));
      mkdirSync(outDir, { recursive: true });
      const outFile = resolve(outDir, 'index.html');
      writeFileSync(outFile, html, 'utf-8');
    }

  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
}

main().catch((err) => {
  console.error('❌ Prerender failed:', err.message);
  // Don't fail the build — prerender is a best-effort enhancement
  process.exit(0);
});
