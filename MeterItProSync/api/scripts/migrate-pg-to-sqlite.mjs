/**
 * One-time migration: copy tenant + meter_reading from the legacy local
 * Postgres sync database into the new SQLite sync database.
 *
 * Usage (from MeterItProSync/api, after `npm run build`):
 *   node --env-file=../../.env scripts/migrate-pg-to-sqlite.mjs
 */

import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adapterPath = resolve(__dirname, '../dist/framework/backend/shared/helpers/sqlite-pool.js');
const { SqlitePool, ensureSyncSchema, resolveSyncDbPath } = await import('file:///' + adapterPath.replace(/\\/g, '/'));

const BATCH_SIZE = 1000;

const pgPool = new pg.Pool({
  host: process.env.POSTGRES_SYNC_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_SYNC_PORT || '5432', 10),
  database: process.env.POSTGRES_SYNC_DB || 'postgres',
  user: process.env.POSTGRES_SYNC_USER || 'postgres',
  password: process.env.POSTGRES_SYNC_PASSWORD || '',
});

const sqlitePath = resolveSyncDbPath();
const sqlite = new SqlitePool(sqlitePath);
ensureSyncSchema(sqlite);

/** Columns present in BOTH source (pg) and target (sqlite) for a table */
async function commonColumns(table) {
  const pgCols = (await pgPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'`,
    [table]
  )).rows.map((r) => r.column_name);

  const sqliteCols = sqlite.raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  const target = new Set(sqliteCols);
  const cols = pgCols.filter((c) => target.has(c));
  const skipped = pgCols.filter((c) => !target.has(c));
  if (skipped.length) console.log(`  (skipping pg-only columns on ${table}: ${skipped.join(', ')})`);
  return cols;
}

async function migrateTable(table, orderBy) {
  const cols = await commonColumns(table);
  const colList = cols.join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${placeholders})`;

  const total = parseInt((await pgPool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n, 10);

  let copied = 0;
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const batch = (await pgPool.query(
      `SELECT ${colList} FROM ${table} ORDER BY ${orderBy} LIMIT ${BATCH_SIZE} OFFSET ${offset}`
    )).rows;
    if (batch.length === 0) break;

    await sqlite.query('BEGIN');
    try {
      for (const row of batch) {
        await sqlite.query(insertSql, cols.map((c) => {
          const v = row[c];
          // pg returns numeric as string; store as number for REAL affinity
          return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && c !== 'sync_status' ? Number(v) : v;
        }));
      }
      await sqlite.query('COMMIT');
    } catch (err) {
      await sqlite.query('ROLLBACK');
      throw err;
    }
    copied += batch.length;
    process.stdout.write(`  ${copied}/${total}\r`);
  }
  return copied;
}

try {
  const tenants = await migrateTable('tenant', 'tenant_id');
  const meters = await migrateTable('meter', 'meter_id, meter_element_id');
  const registers = await migrateTable('register', 'register_id');
  const deviceRegisters = await migrateTable('device_register', 'device_id, register_id');
  const readings = await migrateTable('meter_reading', 'created_at');

  for (const t of ['tenant', 'meter', 'register', 'device_register', 'meter_reading']) {
    const n = (await sqlite.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n;
  }
} catch (err) {
  console.error('\n❌ Migration failed:', err);
  process.exitCode = 1;
} finally {
  await pgPool.end();
  await sqlite.end();
}
