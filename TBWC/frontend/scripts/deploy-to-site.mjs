/**
 * Build the TBWC portal for tbwctechnology.com/portal/ and drop it into the
 * tbwc-site repo, which GitHub Pages serves from the root of its master branch.
 *
 * Same-origin is the point: served under the site's domain, the portal shares
 * localStorage with it, so a rep who signed in out front is already signed in here
 * (see src/utils/sharedSession.ts). That only holds if the app really is at
 * /portal/ on that domain — hence the fixed base path below.
 *
 * The built files are committed to tbwc-site; this script only writes them.
 * Run: npm run deploy:site   (then commit + push in tbwc-site)
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// C:\Projects\Synergy\TBWC\frontend -> C:\Projects\tbwc-site (sibling repos).
const defaultSiteDir = path.resolve(frontendDir, '../../../tbwc-site');
const siteDir = process.env.TBWC_SITE_DIR || defaultSiteDir;
const outDir = path.join(siteDir, 'portal');
const BASE_PATH = '/portal/';

if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) {
  console.error(`[deploy:site] tbwc-site not found at ${siteDir}`);
  console.error('[deploy:site] Clone it beside Synergy, or set TBWC_SITE_DIR.');
  process.exit(1);
}
if (!existsSync(path.join(siteDir, 'CNAME'))) {
  console.error(`[deploy:site] ${siteDir} has no CNAME — that doesn't look like tbwc-site.`);
  process.exit(1);
}

console.log(`[deploy:site] building with base ${BASE_PATH}`);
execFileSync('npm', ['run', 'build'], {
  cwd: frontendDir,
  stdio: 'inherit',
  shell: true, // npm is a .cmd on Windows
  env: { ...process.env, VITE_BASE_PATH: BASE_PATH },
});

const distDir = path.join(frontendDir, 'dist');
if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error('[deploy:site] build produced no dist/index.html — aborting.');
  process.exit(1);
}

console.log(`[deploy:site] replacing ${outDir}`);
rmSync(outDir, { recursive: true, force: true });
cpSync(distDir, outDir, { recursive: true });

console.log('[deploy:site] done. Next:');
console.log(`  cd ${siteDir} && git add portal && git commit -m "Update rep portal build" && git push`);
