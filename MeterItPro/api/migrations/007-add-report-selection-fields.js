/**
 * Database Migration: Add Report Selection Fields
 * Adds meter_ids, element_ids, register_ids, and html_format columns to report table
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
      // Add meter_ids column (TEXT[] for array of meter IDs)
      `ALTER TABLE IF EXISTS public.report 
       ADD COLUMN IF NOT EXISTS meter_ids TEXT[] DEFAULT '{}'`,
      
      // Add element_ids column (TEXT[] for array of element IDs)
      `ALTER TABLE IF EXISTS public.report 
       ADD COLUMN IF NOT EXISTS element_ids TEXT[] DEFAULT '{}'`,
      
      // Add register_ids column (TEXT[] for array of register IDs)
      `ALTER TABLE IF EXISTS public.report 
       ADD COLUMN IF NOT EXISTS register_ids TEXT[] DEFAULT '{}'`,
      
      // Add html_format column (BOOLEAN for HTML formatting preference)
      `ALTER TABLE IF EXISTS public.report 
       ADD COLUMN IF NOT EXISTS html_format BOOLEAN DEFAULT false`,
      
      // Create indexes for better query performance
      `CREATE INDEX IF NOT EXISTS idx_report_meter_ids ON public.report USING GIN(meter_ids)`,
      `CREATE INDEX IF NOT EXISTS idx_report_element_ids ON public.report USING GIN(element_ids)`,
      `CREATE INDEX IF NOT EXISTS idx_report_register_ids ON public.report USING GIN(register_ids)`,
      `CREATE INDEX IF NOT EXISTS idx_report_html_format ON public.report(html_format)`,
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
