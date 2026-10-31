/**
 * Database Migration Runner for Cloudflare Worker
 * Executes SQL migration files in order against Supabase
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function runMigrations() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.uueumbslimaecposqsdf:ZfyUDh!_x4bSYXm@aws-1-us-west-1.pooler.supabase.com:6543/postgres'
  });

  try {
    await client.connect();

    // Get all migration files
    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      return;
    }


    // Execute each migration
    for (const file of files) {

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      try {
        await client.query(sql);
      } catch (error) {
        console.error(`❌ Migration failed: ${file}`);
        console.error(`Error: ${error.message}`);
        throw error;
      }
    }

  } catch (error) {
    console.error('\n❌ Migration process failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run migrations if this script is executed directly
if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };
