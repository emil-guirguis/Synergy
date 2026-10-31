/**
 * Apply specific migration files by name, in order.
 * Usage: node apply-one.js 045-quality-engine.sql 046-notification-state.sql
 *
 * Exists because run-migrations.js replays every .sql file and older,
 * non-idempotent migrations (e.g. 028) fail on re-run.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node apply-one.js <migration.sql> [...more]');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL ||
    `postgresql://${process.env.POSTGRES_USER}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`;

  const client = new Client({ connectionString });
  await client.connect();

  try {
    for (const file of files) {
      const filePath = path.join(__dirname, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
