// Dev-only read helper: run a SQL statement against the TBWC Supabase pooler
// using the DATABASE_URL already declared in wrangler.toml [vars].
//   node scripts/db-query.cjs "select ... "
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const toml = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8');
const m = toml.match(/^DATABASE_URL\s*=\s*"([^"]+)"/m);
if (!m) throw new Error('DATABASE_URL not found in wrangler.toml');

(async () => {
  const client = new Client({ connectionString: m[1], ssl: false });
  await client.connect();
  const result = await client.query(process.argv[2]);
  console.log(JSON.stringify(result.rows, null, 1));
  await client.end();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
