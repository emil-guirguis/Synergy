#!/usr/bin/env node
/**
 * Fails if `console.log` reappears in runtime application or framework code.
 *
 * Why this exists alongside eslint: eslint is only installed in
 * MeterItPro/frontend and MeterItProSync/frontend, so it cannot see TBWC,
 * framework, or either Worker — and those Workers are exactly where a stray
 * log leaks data into Cloudflare's log stream. This check needs no
 * dependencies, so it covers every package.
 *
 *   node scripts/check-no-console.cjs          # report and exit 1 on failure
 *   node scripts/check-no-console.cjs --list   # just list, always exit 0
 *
 * console.warn and console.error are always fine: they report problems rather
 * than trace flow. If you want flow diagnostics, gate them behind an explicit
 * flag (LOG_SQL in api/worker/db.ts is the pattern) or a named debug helper,
 * then add the file to ALLOWED below with a reason.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['TBWC', 'MeterItPro', 'MeterItProSync', 'framework'];
const EXTS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'coverage', '.wrangler', '.git']);

/**
 * Paths where console.log is the point, each with the reason it is exempt.
 * Matched as a substring of the repo-relative path, forward slashes.
 */
const ALLOWED = [
  // The log IS the product's output here.
  ['MeterItProSync/mcp/', 'sync service progress output — its only UI'],
  ['/scripts/', 'CLI tools and installers; stdout is the interface'],
  ['/migrations/', 'one-shot migration scripts run by hand'],
  ['/vite-plugins/', 'build-time output, printed during a build'],
  ['/docs/', 'documentation build tooling'],

  // Purpose-built debug and logging helpers.
  ['debugConsole.ts', 'registers window.*.* devtools helpers; dev/?debug only'],
  ['worker-logger.ts', 'the logger implementation itself'],
  ['shared/utils/logger.js', 'the logger implementation itself'],
  ['shared/helpers/sql-functions.ts', 'console-backed Logger adapter'],
  ['mcp/base/MCPServer.ts', 'console-backed logger for the MCP base server'],
  ['form/utils/schemaLoader.ts', 'logSchemasInMemory() cache dump, called on demand'],
  ['form/utils/fieldValidation.ts', 'logEntityStructure() dump + verbose-gated checks'],

  // Flag-gated: silent unless LOG_SQL is set. See the Env comment in each.
  ['TBWC/api/worker/db.ts', 'SQL logging gated behind LOG_SQL'],
  ['MeterItPro/api/worker/db.ts', 'SQL logging gated behind LOG_SQL'],

  // Tests are not shipped, and a failing assertion is easier to read with one.
  ['.test.', 'test file'],
  ['.spec.', 'test file'],
];

const LIST_ONLY = process.argv.includes('--list');

function allowReason(rel) {
  const hit = ALLOWED.find(([frag]) => rel.includes(frag));
  return hit ? hit[1] : null;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(full, out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
let allowedCount = 0;

for (const top of SCAN) {
  for (const file of walk(path.join(ROOT, top))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!src.includes('console.log')) continue;

    const reason = allowReason(rel);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('console.log')) return;
      // A comment mentioning console.log is prose, not a call — this file and
      // the eslint configs both discuss the rule in their own comments.
      const code = line.trimStart();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      // Respect an explicit, reasoned opt-out on the line before.
      const prev = lines[i - 1] || '';
      if (prev.includes('eslint-disable-next-line no-console')) return;
      if (reason) { allowedCount++; return; }
      violations.push(`${rel}:${i + 1}`);
    });
  }
}

if (LIST_ONLY) {
  for (const v of violations) console.log(v);
  console.log(`\n${violations.length} console.log in runtime code, ${allowedCount} allowed`);
  process.exit(0);
}

if (violations.length === 0) {
  console.log(`check-no-console: clean (${allowedCount} allowed by policy)`);
  process.exit(0);
}

console.error(`check-no-console: ${violations.length} console.log in runtime code\n`);
for (const v of violations) console.error('  ' + v);
console.error(
  '\nUse console.warn/console.error to report a problem, or gate flow\n' +
  'diagnostics behind a flag (see LOG_SQL in api/worker/db.ts) or a named\n' +
  'debug helper. Genuinely exempt file? Add it to ALLOWED in this script\n' +
  'with the reason, or put an "eslint-disable-next-line no-console" above\n' +
  'the single line that needs it.'
);
process.exit(1);
