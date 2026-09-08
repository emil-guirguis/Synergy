all sql tables primary key will be [table name].[table name]_id, not [table name].id

## Stack Context
- Backend runs on Cloudflare Workers (Wrangler). Local dev uses `.dev.vars`; production uses `wrangler secret`. Always check both when debugging env issues.
- Database queries should go through `execQuery` (Worker-aware adapter in db.ts) for consistent logging.
- When adding test/debug attributes, place them on MUI root elements, not wrapper divs.

## Root Cause Analysis
- When fixing bugs, identify the ACTUAL root cause before making changes. Do not patch symptoms.
- For SQL/query issues: check if GROUP BY/aggregation is losing needed data (e.g., MAX() drops timestamps).
- For env/config issues, see the diagnose-env skill.
- For 'I don't see the changes' reports: verify the change is actually rendered/applied, not just written to disk.

## Build Hygiene
- After modifying TypeScript service code, run the clean+build step before assuming changes took effect — stale dist files have caused multiple confusing errors.
- Every service package.json should have a `clean` script that works on Windows (use rimraf, not rm -rf).

## Scope Discipline
- Before large refactors, state the file list and approach in 3-5 lines and wait for confirmation. Avoid open-ended exploration — one session burned 38 minutes exploring without producing a fix.
- Do not over-engineer. When fixing a recent regression, diagnose the recent change first before proposing redesigns.
