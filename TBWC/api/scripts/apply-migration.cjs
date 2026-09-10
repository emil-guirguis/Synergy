// Apply one migration file to the DB in wrangler.toml's DATABASE_URL.
//   node scripts/apply-migration.cjs migrations/027-inventory-images.sql
// Wrapped in a transaction: a failing statement rolls the whole file back.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const toml = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8');
const url = (toml.match(/^DATABASE_URL\s*=\s*"([^"]+)"/m) || [])[1];
if (!url) throw new Error('DATABASE_URL not found in wrangler.toml');

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/apply-migration.cjs <path-to.sql>');
const sql = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

(async () => {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`applied ${file}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
