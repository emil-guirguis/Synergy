/**
 * Database Migration: Rename Primary Keys in Reporting Module Tables
 * Renames id columns to follow [tablename]_id convention
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('../src/config/database');

async function runMigration() {
  let wasAlreadyConnected = false;
  
  try {
    
    // Check if database is already connected
    wasAlreadyConnected = db.isConnected;
    
    // Only connect if not already connected
    if (!wasAlreadyConnected) {
      await db.connect();
    } else {
    }
    
    // Define all SQL statements to execute
    const statements = [
      // Drop foreign key constraints first
      `ALTER TABLE report_history DROP CONSTRAINT IF EXISTS report_history_report_id_fkey`,
      `ALTER TABLE report_email_logs DROP CONSTRAINT IF EXISTS report_email_logs_report_id_fkey`,
      `ALTER TABLE report_email_logs DROP CONSTRAINT IF EXISTS report_email_logs_history_id_fkey`,
      
      // Rename primary keys
      `ALTER TABLE reports RENAME COLUMN id TO report_id`,
      `ALTER TABLE report_history RENAME COLUMN id TO report_history_id`,
      `ALTER TABLE report_history RENAME COLUMN report_id TO report_id`,
      `ALTER TABLE report_email_logs RENAME COLUMN id TO report_email_logs_id`,
      `ALTER TABLE report_email_logs RENAME COLUMN report_id TO report_id`,
      `ALTER TABLE report_email_logs RENAME COLUMN history_id TO report_history_id`,
      
      // Re-add foreign key constraints
      `ALTER TABLE report_history ADD CONSTRAINT report_history_report_id_fkey 
       FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE`,
      `ALTER TABLE report_email_logs ADD CONSTRAINT report_email_logs_report_id_fkey 
       FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE`,
      `ALTER TABLE report_email_logs ADD CONSTRAINT report_email_logs_report_history_id_fkey 
       FOREIGN KEY (report_history_id) REFERENCES report_history(report_history_id) ON DELETE CASCADE`,
      
      // Rename indexes
      `ALTER INDEX IF EXISTS idx_report_history_report_id RENAME TO idx_report_history_report_id`,
      `ALTER INDEX IF EXISTS idx_report_email_logs_report_id RENAME TO idx_report_email_logs_report_id`,
      `ALTER INDEX IF EXISTS idx_report_email_logs_history_id RENAME TO idx_report_email_logs_report_history_id`,
      `ALTER INDEX IF EXISTS idx_report_history_report_executed RENAME TO idx_report_history_reports_executed`,
      `ALTER INDEX IF EXISTS idx_report_email_logs_history_recipient RENAME TO idx_report_email_logs_report_history_recipient`,
    ];
    
    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const statementNum = i + 1;
      
      try {
        await db.query(statement);
      } catch (error) {
        console.error(`❌ Statement ${statementNum} failed`);
        console.error(`Error: ${error.message}`);
        throw error;
      }
    }
    
    
  } catch (error) {
    console.error('\n❌ Migration process failed:', error.message);
    process.exit(1);
  } finally {
    // Only disconnect if we connected in this function
    if (!wasAlreadyConnected && db.isConnected) {
      await db.disconnect();
    } else if (wasAlreadyConnected) {
    }
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
