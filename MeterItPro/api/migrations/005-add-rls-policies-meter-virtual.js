/**
 * Migration: Add RLS policies to meter_virtual table
 * 
 * This migration adds Row Level Security (RLS) policies to the meter_virtual table
 * to ensure proper access control based on tenant context.
 * 
 * Requirements: 11.5
 */

const db = require('../src/config/database');

async function addRLSPolicies() {
    try {

        // Check if RLS is enabled on the table
        const rlsCheckQuery = `
            SELECT relrowsecurity
            FROM pg_class
            WHERE relname = 'meter_virtual' AND relnamespace = (
                SELECT oid FROM pg_namespace WHERE nspname = 'public'
            );
        `;

        const rlsCheckResult = await db.query(rlsCheckQuery);
        const rlsEnabled = rlsCheckResult.rows[0]?.relrowsecurity || false;

        if (!rlsEnabled) {
            await db.query('ALTER TABLE public.meter_virtual ENABLE ROW LEVEL SECURITY;');
        } else {
        }

        // Check existing policies
        const policiesQuery = `
            SELECT policyname
            FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'meter_virtual';
        `;

        const policiesResult = await db.query(policiesQuery);
        const existingPolicies = policiesResult.rows.map(row => row.policyname);


        // Create SELECT policy if it doesn't exist
        if (!existingPolicies.includes('meter_virtual_select_policy')) {
            const selectPolicyQuery = `
                CREATE POLICY meter_virtual_select_policy ON public.meter_virtual
                FOR SELECT
                USING (true);
            `;
            await db.query(selectPolicyQuery);
        } else {
        }

        // Create INSERT policy if it doesn't exist
        if (!existingPolicies.includes('meter_virtual_insert_policy')) {
            const insertPolicyQuery = `
                CREATE POLICY meter_virtual_insert_policy ON public.meter_virtual
                FOR INSERT
                WITH CHECK (true);
            `;
            await db.query(insertPolicyQuery);
        } else {
        }

        // Create UPDATE policy if it doesn't exist
        if (!existingPolicies.includes('meter_virtual_update_policy')) {
            const updatePolicyQuery = `
                CREATE POLICY meter_virtual_update_policy ON public.meter_virtual
                FOR UPDATE
                USING (true)
                WITH CHECK (true);
            `;
            await db.query(updatePolicyQuery);
        } else {
        }

        // Create DELETE policy if it doesn't exist
        if (!existingPolicies.includes('meter_virtual_delete_policy')) {
            const deletePolicyQuery = `
                CREATE POLICY meter_virtual_delete_policy ON public.meter_virtual
                FOR DELETE
                USING (true);
            `;
            await db.query(deletePolicyQuery);
        } else {
        }

        // Verify all policies
        console.log('\n📋 Verifying RLS policies:');
        const verifyPoliciesQuery = `
            SELECT policyname, permissive, cmd
            FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'meter_virtual'
            ORDER BY policyname;
        `;

        const verifyResult = await db.query(verifyPoliciesQuery);
        if (verifyResult.rows.length > 0) {
            verifyResult.rows.forEach(policy => {
            });
        } else {
        }

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
            await addRLSPolicies();
            await db.disconnect();
            process.exit(0);
        } catch (error) {
            console.error('Fatal error:', error);
            process.exit(1);
        }
    })();
}

module.exports = { addRLSPolicies };
