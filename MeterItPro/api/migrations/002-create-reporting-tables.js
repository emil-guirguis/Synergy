/**
 * Database Migration: Create Reporting Module Tables
 * Creates Reports, Report_History, and Email_Logs tables with indexes
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
      // Drop existing tables if they exist (for clean migration)
      `DROP TABLE IF EXISTS public.report_email_logs CASCADE`,
      `DROP TABLE IF EXISTS public.report_history CASCADE`,
      `DROP TABLE IF EXISTS public.report CASCADE`,
      
      // Create Report table (renamed from reports)
      `CREATE TABLE IF NOT EXISTS public.report (
        report_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 ),
        name character varying(255) COLLATE pg_catalog."default" NOT NULL,
        type character varying(50) COLLATE pg_catalog."default" NOT NULL,
        schedule character varying(255) COLLATE pg_catalog."default" NOT NULL,
        recipients text[] COLLATE pg_catalog."default" NOT NULL,
        config jsonb NOT NULL,
        enabled boolean DEFAULT true,
        created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT report_pkey PRIMARY KEY (report_id),
        CONSTRAINT report_name_key UNIQUE (name)
      )`,
      
      // Grant permissions on report table
      `ALTER TABLE IF EXISTS public.report OWNER to postgres`,
      `GRANT ALL ON TABLE public.report TO anon`,
      `GRANT ALL ON TABLE public.report TO authenticated`,
      `GRANT ALL ON TABLE public.report TO postgres`,
      `GRANT ALL ON TABLE public.report TO service_role`,
      
      // Create Report_History table
      `CREATE TABLE IF NOT EXISTS public.report_history (
        report_history_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 ),
        report_id bigint NOT NULL REFERENCES public.report(report_id) ON DELETE CASCADE,
        executed_at timestamp without time zone NOT NULL,
        status character varying(20) COLLATE pg_catalog."default" NOT NULL,
        error_message text COLLATE pg_catalog."default",
        created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT report_history_pkey PRIMARY KEY (report_history_id)
      )`,
      
      // Grant permissions on report_history table
      `ALTER TABLE IF EXISTS public.report_history OWNER to postgres`,
      `GRANT ALL ON TABLE public.report_history TO anon`,
      `GRANT ALL ON TABLE public.report_history TO authenticated`,
      `GRANT ALL ON TABLE public.report_history TO postgres`,
      `GRANT ALL ON TABLE public.report_history TO service_role`,
      
      // Create Report_Email_Logs table
      `CREATE TABLE IF NOT EXISTS public.report_email_logs (
        report_email_logs_id bigint NOT NULL GENERATED ALWAYS AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 ),
        report_id bigint NOT NULL REFERENCES public.report(report_id) ON DELETE CASCADE,
        report_history_id bigint NOT NULL REFERENCES public.report_history(report_history_id) ON DELETE CASCADE,
        recipient character varying(255) COLLATE pg_catalog."default" NOT NULL,
        sent_at timestamp without time zone NOT NULL,
        status character varying(20) COLLATE pg_catalog."default" NOT NULL,
        error_details text COLLATE pg_catalog."default",
        created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT report_email_logs_pkey PRIMARY KEY (report_email_logs_id)
      )`,
      
      // Grant permissions on report_email_logs table
      `ALTER TABLE IF EXISTS public.report_email_logs OWNER to postgres`,
      `GRANT ALL ON TABLE public.report_email_logs TO anon`,
      `GRANT ALL ON TABLE public.report_email_logs TO authenticated`,
      `GRANT ALL ON TABLE public.report_email_logs TO postgres`,
      `GRANT ALL ON TABLE public.report_email_logs TO service_role`,
      
      // Create indexes for report_history
      `CREATE INDEX IF NOT EXISTS idx_report_history_report_id ON public.report_history(report_id)`,
      `CREATE INDEX IF NOT EXISTS idx_report_history_executed_at ON public.report_history(executed_at)`,
      `CREATE INDEX IF NOT EXISTS idx_report_history_report_executed ON public.report_history(report_id, executed_at DESC)`,
      
      // Create indexes for report_email_logs
      `CREATE INDEX IF NOT EXISTS idx_report_email_logs_report_id ON public.report_email_logs(report_id)`,
      `CREATE INDEX IF NOT EXISTS idx_report_email_logs_history_id ON public.report_email_logs(report_history_id)`,
      `CREATE INDEX IF NOT EXISTS idx_report_email_logs_recipient ON public.report_email_logs(recipient)`,
      `CREATE INDEX IF NOT EXISTS idx_report_email_logs_sent_at ON public.report_email_logs(sent_at)`,
      `CREATE INDEX IF NOT EXISTS idx_report_email_logs_history_recipient ON public.report_email_logs(report_history_id, recipient)`
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
