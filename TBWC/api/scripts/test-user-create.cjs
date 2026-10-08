// Live regression check for admin-created users (routes/users.ts POST /).
// Exercises the real Supabase Admin API + DB, not mocks — this is the thing
// worker/routes/users.test.ts can only simulate. Creates a throwaway rep,
// confirms the auth.users <-> public.users link, exercises the duplicate-email
// and rollback paths, then deletes everything it made.
//   node scripts/test-user-create.cjs
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const toml = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8');
const DATABASE_URL = (toml.match(/^DATABASE_URL\s*=\s*"([^"]+)"/m) || [])[1];
const SUPABASE_URL = (toml.match(/^SUPABASE_URL\s*=\s*"([^"]+)"/m) || [])[1];
const devVars = fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8');
const SUPABASE_SERVICE_ROLE_KEY = (devVars.match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\n]+)"?$/m) || [])[1];
if (!DATABASE_URL) throw new Error('DATABASE_URL not found in wrangler.toml');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL not found in wrangler.toml');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not found in .dev.vars');

const ADMIN_BASE = SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/admin/users';
const authHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
function ok(label) { pass++; console.log('  [OK]   ' + label); }
function bad(label, detail) { fail++; console.log('  [FAIL] ' + label + (detail ? ' — ' + detail : '')); }
function assert(cond, label, detail) { cond ? ok(label) : bad(label, detail); }

async function createAuthUser(email) {
  const res = await fetch(ADMIN_BASE, { method: 'POST', headers: authHeaders, body: JSON.stringify({ email, email_confirm: true }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function deleteAuthUser(id) {
  await fetch(ADMIN_BASE + '/' + id, { method: 'DELETE', headers: authHeaders }).catch(() => {});
}

async function testCreateAndLink(db) {
  console.log('\nManual create — auth.users row + linked public.users profile');
  const email = 'test-admin-create-' + Date.now() + '@example.com';

  const created = await createAuthUser(email);
  assert(created.status === 200 && created.json.id, 'Admin API creates the auth user', JSON.stringify(created.json));
  if (!created.json.id) return;
  const authId = created.json.id;

  assert(created.json.email_confirmed_at != null, 'auth user is pre-confirmed (no signup email needed)');

  try {
    const insert = await db.query(
      `insert into public.users (id, first_name, last_name, email, type, approved)
       values ($1, 'Test', 'AdminCreate', $2, 'rep', false) returning id`,
      [authId, email]
    );
    assert(insert.rowCount === 1, 'public.users profile insert succeeds with the auth id as PK/FK');

    const joined = await db.query(
      `select u.email, a.email as auth_email from public.users u
       join auth.users a on a.id = u.id where u.id = $1`,
      [authId]
    );
    assert(joined.rowCount === 1 && joined.rows[0].email === joined.rows[0].auth_email, 'profile row joins back to its auth.users row');
  } finally {
    await db.query('delete from public.users where id = $1', [authId]);
    await deleteAuthUser(authId);
  }
}

async function testDuplicateEmailRejected() {
  console.log('\nDuplicate email — Admin API refuses a second account for the same address');
  const email = 'test-admin-dup-' + Date.now() + '@example.com';

  const first = await createAuthUser(email);
  assert(first.status === 200 && first.json.id, 'first create succeeds');

  try {
    const second = await createAuthUser(email);
    assert(second.status >= 400, 'second create with the same email is rejected', JSON.stringify(second.json));
  } finally {
    if (first.json.id) await deleteAuthUser(first.json.id);
  }
}

async function testOrphanRollback(db) {
  console.log('\nRollback — a failed profile insert must not leave an orphaned auth user');
  const email = 'test-admin-rollback-' + Date.now() + '@example.com';

  const created = await createAuthUser(email);
  assert(created.status === 200 && created.json.id, 'auth user created for the rollback case');
  const authId = created.json.id;

  // role_id references public.role(role_id) — this FK violation is what
  // users.ts's create() throws on, which is what should trigger deleteAuthUser().
  let insertFailed = false;
  try {
    await db.query(
      `insert into public.users (id, first_name, last_name, email, type, role_id)
       values ($1, 'Test', 'Rollback', $2, 'rep', -999999)`,
      [authId, email]
    );
  } catch {
    insertFailed = true;
  }
  assert(insertFailed, 'profile insert fails as expected (bad role_id FK)');

  // Mirror what users.ts does on that failure: delete the auth user it just made.
  await deleteAuthUser(authId);
  const check = await createAuthUser(email);
  assert(check.status === 200 && check.json.id, 'auth user no longer exists after rollback — email is free again', JSON.stringify(check.json));
  if (check.json.id) await deleteAuthUser(check.json.id);
}

async function main() {
  const db = new Client({ connectionString: DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await testCreateAndLink(db);
    await testDuplicateEmailRejected();
    await testOrphanRollback(db);
  } finally {
    await db.end();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test run crashed:', err.message);
  process.exit(1);
});
