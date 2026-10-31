/**
 * Migration: Fix meter_virtual column name
 * 
 * This migration fixes the column name from "select meter_element_id" (with space)
 * to "select_meter_element_id" (with underscore) to match the design specification.
 * 
 * Requirements: 11.1
 */

const db = require('../src/config/database');

async function fixColumnName() {
    try {

        // Check current column name
        const checkQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'meter_virtual'
            AND column_name LIKE '%element%'
            ORDER BY ordinal_position;
        `;

        const checkResult = await db.query(checkQuery);
        
        if (checkResult.rows.length === 0) {
            return true;
        }

        const currentColumnName = checkResult.rows[0].column_name;

        if (currentColumnName === 'select_meter_element_id') {
            return true;
        }

        // Need to rename the column
        console.log(`\nRenaming column from "${currentColumnName}" to "select_meter_element_id"`);

        // First, drop the primary key constraint
        console.log('\nDropping primary key constraint');
        await db.query('ALTER TABLE public.meter_virtual DROP CONSTRAINT meter_virtual_pkey;');

        // Rename the column
        console.log('\nRenaming column');
        const renameQuery = `ALTER TABLE public.meter_virtual RENAME COLUMN "${currentColumnName}" TO select_meter_element_id;`;
        await db.query(renameQuery);

        // Recreate the primary key constraint with correct column names
        console.log('\nRecreating primary key constraint');
        const createPkQuery = `
            ALTER TABLE public.meter_virtual 
            ADD CONSTRAINT meter_virtual_pkey 
            PRIMARY KEY (meter_virtual_id, meter_id, selected_meter_id, select_meter_element_id);
        `;
        await db.query(createPkQuery);

        // Verify the fix
        console.log('\n📋 Verifying column names:');
        const verifyQuery = `
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'meter_virtual'
            ORDER BY ordinal_position;
        `;

        const verifyResult = await db.query(verifyQuery);
        verifyResult.rows.forEach(col => {
        });

        return true;

    } catch (error) {
        console.error('\n❌ Migration failed:', error instanceof Error ? error.message : error);
        throw error;
    }
}

// Run migration if this file is executed directly
if (require.main === module) {
    (async () => {
        try {
            await db.connect();
            await fixColumnName();
            await db.disconnect();
            process.exit(0);
        } catch (error) {
            console.error('Fatal error:', error);
            process.exit(1);
        }
    })();
}

module.exports = { fixColumnName };
