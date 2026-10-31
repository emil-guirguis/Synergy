/**
 * DB Schema Sync Check
 *
 * Automatically scans all *Schema.ts files and cross-references against the
 * live database. Three types of checks:
 *
 *   1. TABLE EXISTS     — every schema.tableName must exist in the DB
 *   2. COLUMN EXISTS    — every schema field's dbField must exist in that table
 *   3. ENUM SYNC        — every schema field's enumValues must match the DB
 *                         CHECK constraint (if one exists), and vice-versa
 *
 * Also checks manually declared frontend option arrays (dropdowns that submit
 * directly to the DB but don't go through a *Schema.ts file).
 *
 * Run:   npm run check:constraints
 * Exit:  0 = all clear,  1 = critical failures found
 *
 * ── Adding a new schema ──────────────────────────────────────────────────────
 * Nothing to do. The scanner picks up any new *Schema.ts file automatically.
 *
 * ── Adding a frontend option array ──────────────────────────────────────────
 * Add an entry to FRONTEND_OPTIONS at the bottom of this file.
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ── Connection ───────────────────────────────────────────────────────────────

function getConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const toml = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8');
  const m = toml.match(/localConnectionString\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('No DATABASE_URL and no localConnectionString in wrangler.toml');
  return m[1];
}

// ── Schema file parser ───────────────────────────────────────────────────────

interface FieldDef {
  name: string;
  dbField: string;
  enumValues?: string[];
}

interface SchemaDef {
  file: string;
  tableName: string;
  fields: FieldDef[];
}

/** Extract the content of every field({...}) call, respecting brace nesting. */
function extractFieldBlocks(src: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf('field({', i);
    if (start === -1) break;
    let depth = 0;
    let j = start + 'field('.length; // points at opening '{'
    while (j < src.length) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { blocks.push(src.slice(start + 'field('.length, j + 1)); break; } }
      j++;
    }
    i = j + 1;
  }
  return blocks;
}

function parseEnum(block: string): string[] | undefined {
  const m = block.match(/enumValues:\s*\[([^\]]+)\]/);
  if (!m) return undefined;
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function parseSchemaFiles(routesDir: string): SchemaDef[] {
  const results: SchemaDef[] = [];
  const files = fs.readdirSync(routesDir).filter(f => f.endsWith('Schema.ts'));

  for (const file of files) {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const tableMatch = src.match(/tableName:\s*'([^']+)'/);
    if (!tableMatch) continue;
    const tableName = tableMatch[1];

    const fields: FieldDef[] = [];
    const seenDbFields = new Set<string>();

    for (const block of extractFieldBlocks(src)) {
      const nameMatch   = block.match(/\bname:\s*'([^']+)'/);
      const dbFieldMatch = block.match(/\bdbField:\s*'([^']+)'/);
      if (!nameMatch || !dbFieldMatch) continue;

      const dbField = dbFieldMatch[1];
      if (seenDbFields.has(dbField)) continue; // skip duplicates across formTabs/formFields
      seenDbFields.add(dbField);

      fields.push({ name: nameMatch[1], dbField, enumValues: parseEnum(block) });
    }

    if (fields.length > 0) results.push({ file, tableName, fields });
  }

  return results;
}

// ── DB queries ───────────────────────────────────────────────────────────────

interface ColumnInfo { table: string; column: string; nullable: boolean; }
interface ConstraintInfo { table: string; conname: string; column: string; values: string[]; }

async function fetchColumns(client: Client): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name)!.add(r.column_name);
  }
  return map;
}

async function fetchConstraints(client: Client): Promise<Map<string, ConstraintInfo>> {
  const { rows } = await client.query<{ table_name: string; conname: string; def: string; columns: string[] }>(`
    SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def,
           array_agg(a.attname) AS columns
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'c' AND n.nspname = 'public'
    GROUP BY t.relname, c.conname, c.oid
  `);

  const map = new Map<string, ConstraintInfo>();
  for (const r of rows) {
    const values = [...r.def.matchAll(/'([^']+)'::/g)].map(m => m[1]);
    if (values.length === 0) continue; // not an ANY(ARRAY[...]) constraint
    // Extract column name from constraint def (more reliable than pg_attribute array parsing)
    const colMatch = r.def.match(/\((\w+)\)::text\s*=\s*ANY/);
    const col = colMatch?.[1] ?? '';
    if (!col) continue;
    map.set(`${r.table_name}.${col}`, { table: r.table_name, conname: r.conname, column: col, values });
  }
  return map;
}

// ── Reporting helpers ────────────────────────────────────────────────────────

const R = '\x1b[0m', RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', BOLD = '\x1b[1m', DIM = '\x1b[2m';

let criticals = 0, warnings = 0, passes = 0;

function pass(msg: string)  { passes++;   console.log(`  ${GRN}✓${R}  ${msg}`); }
function warn(msg: string)  { warnings++; console.log(`  ${YEL}⚠${R}  ${msg}`); }
function fail(msg: string)  { criticals++; console.log(`  ${RED}${BOLD}✗ CRITICAL${R}  ${msg}`); }
function info(msg: string)  { console.log(`  ${DIM}  ${msg}${R}`); }

// ── Frontend option arrays (manual — no *Schema.ts counterpart) ──────────────

interface FrontendOption { label: string; table: string; column: string; values: string[]; }

const FRONTEND_OPTIONS: FrontendOption[] = [
  {
    label: 'TIME_FRAME_OPTIONS  framework/frontend/dashboards/dashboardOptions.ts',
    table: 'dashboard', column: 'time_frame_type',
    values: ['today', 'this_month_to_date', 'last_month', 'since_installation', 'yearly', 'custom'],
  },
  {
    label: 'VISUALIZATION_OPTIONS  framework/frontend/dashboards/dashboardOptions.ts',
    table: 'dashboard', column: 'visualization_type',
    values: ['bar', 'line', 'area', 'pie', 'candlestick', 'list'],
  },
  {
    label: 'GROUPING_OPTIONS  framework/frontend/dashboards/dashboardOptions.ts',
    table: 'dashboard', column: 'grouping_type',
    values: ['total', 'hourly', 'daily', 'weekly', 'monthly'],
  },
  {
    label: 'AGGREGATION_OPTIONS  framework/frontend/dashboards/dashboardOptions.ts',
    table: 'dashboard', column: 'aggregation_type',
    values: ['none', 'sum', 'average', 'min', 'max'],
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Client({ connectionString: getConnectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();

  let dbColumns: Map<string, Set<string>>;
  let dbConstraints: Map<string, ConstraintInfo>;

  try {
    [dbColumns, dbConstraints] = await Promise.all([fetchColumns(client), fetchConstraints(client)]);
  } finally {
    await client.end();
  }

  const routesDir = path.join(__dirname, '..', 'worker', 'routes');
  const schemas = parseSchemaFiles(routesDir);

  // ── 1. Schema-driven checks ───────────────────────────────────────────────

  console.log(`\n${BOLD}── Schema checks (${schemas.length} schema files) ──────────────────────────────${R}`);

  for (const schema of schemas) {

    // Table existence
    if (!dbColumns.has(schema.tableName)) {
      fail(`table '${schema.tableName}' does not exist in DB`);
      continue;
    } else {
      pass(`table '${schema.tableName}' exists`);
    }

    const tableColumns = dbColumns.get(schema.tableName)!;

    for (const field of schema.fields) {
      // Column existence
      if (!tableColumns.has(field.dbField)) {
        fail(`column '${field.dbField}' does not exist in ${schema.tableName}`);
        continue;
      }

      if (!field.enumValues) {
        pass(`${schema.tableName}.${field.dbField}`);
        continue;
      }

      // Enum sync
      const constraint = dbConstraints.get(`${schema.tableName}.${field.dbField}`);
      const schemaSet = new Set(field.enumValues);

      if (!constraint) {
        // No DB CHECK constraint — schema-only validation
        warn(`${schema.tableName}.${field.dbField}  →  enumValues defined but NO DB CHECK constraint`);
        info(`schema values: ${field.enumValues.map(v => `'${v}'`).join(', ')}`);
        info(`consider adding a migration with a CHECK constraint`);
        continue;
      }

      const dbSet = new Set(constraint.values);
      const missingFromDb = field.enumValues.filter(v => !dbSet.has(v));
      const missingFromSchema = constraint.values.filter(v => !schemaSet.has(v));

      if (missingFromDb.length > 0) {
        fail(`${schema.tableName}.${field.dbField}  →  schema values rejected by DB: ${missingFromDb.map(v => `'${v}'`).join(', ')}`);
        info(`DB allows: ${constraint.values.map(v => `'${v}'`).join(', ')}`);
      } else if (missingFromSchema.length > 0) {
        warn(`${schema.tableName}.${field.dbField}  →  DB values absent from schema: ${missingFromSchema.map(v => `'${v}'`).join(', ')}`);
        info(`(legacy DB values — unreachable via UI)`);
      } else {
        pass(`${schema.tableName}.${field.dbField}  (${field.enumValues.length} values, DB constraint matches)`);
      }
    }
  }

  // ── 2. Frontend option array checks ──────────────────────────────────────

  console.log(`\n${BOLD}── Frontend option array checks ─────────────────────────────────────────────${R}\n`);

  for (const opt of FRONTEND_OPTIONS) {
    const constraint = dbConstraints.get(`${opt.table}.${opt.column}`);
    if (!constraint) {
      warn(`${opt.table}.${opt.column}  →  no DB CHECK constraint  (${opt.label})`);
      continue;
    }
    const dbSet = new Set(constraint.values);
    const bad = opt.values.filter(v => !dbSet.has(v));
    if (bad.length > 0) {
      fail(`${opt.table}.${opt.column}  →  UI values rejected by DB: ${bad.map(v => `'${v}'`).join(', ')}`);
      info(opt.label);
    } else {
      pass(`${opt.table}.${opt.column}  (${opt.label})`);
    }
  }

  // ── 3. Uncovered DB constraints ───────────────────────────────────────────

  const coveredKeys = new Set([
    ...schemas.flatMap(s => s.fields.map(f => `${s.tableName}.${f.dbField}`)),
    ...FRONTEND_OPTIONS.map(o => `${o.table}.${o.column}`),
  ]);
  const uncovered = [...dbConstraints.keys()].filter(k => !coveredKeys.has(k));
  if (uncovered.length > 0) {
    for (const key of uncovered) {
      const c = dbConstraints.get(key)!;
      warn(`${key}  →  ${c.values.map(v => `'${v}'`).join(', ')}  (${c.conname})`);
      info(`add to a *Schema.ts enumValues or FRONTEND_OPTIONS if UI writes this column`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(70)}`);

  if (criticals > 0) {
    process.exit(1);
  } else {
  }
}

main().catch(e => {
  console.error(`\n${RED}Error:${R}`, e.message);
  process.exit(1);
});
