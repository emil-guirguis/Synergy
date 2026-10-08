/**
 * Users CRUD (admin-only). Table public.users, PK id (uuid).
 * Envelope matches the framework store: list -> {data:{items,total}}, single -> {data}.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { findAll, findById, create, update, remove, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { usersSchema } from './usersSchema';
import { canImpersonate } from '@meterit/framework-backend/api/base/auth';
import { mintSessionForEmail, createAuthUser, deleteAuthUser } from '../supabaseAdmin';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// The Users module is admin-only end to end.
app.use('*', authenticateToken);

const TABLE = 'users';
const PK = 'id';
const SEARCH = ['first_name', 'last_name', 'email', 'agency_name'];
// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — e.g. 'role_id' is excluded, it's an exact-match select).
const LIKE_FIELDS = likeFieldsFromSchema(usersSchema);

/**
 * '(system default)' selects post '' when cleared; the matching column needs
 * null, not ''. Same reasoning as qb_sales_rep_id's FK below.
 */
function normalize(body: Record<string, any>): Record<string, any> {
  if (body.qb_sales_rep_id === '') body.qb_sales_rep_id = null;
  if (body.timezone === '') body.timezone = null;
  if (body.date_format === '') body.date_format = null;
  if (body.time_format === '') body.time_format = null;
  if (body.default_page_size === '' || body.default_page_size === null) {
    body.default_page_size = null;
  } else if (body.default_page_size !== undefined) {
    body.default_page_size = Number(body.default_page_size);
  }
  // last_verified_at is NOT NULL (default now()) — the form sends it as null
  // (readOnly field, default: null) on create, which would override the
  // column default with an explicit NULL and violate the constraint. Drop it
  // so the DB default (or the existing row's own value, on update) applies.
  if (body.last_verified_at === null) delete body.last_verified_at;
  return body;
}

app.get('/', requirePermission('user:read'), async (c) => {
  const q = c.req.query();
  const { where, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS });
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    where,
    whereLike,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', requirePermission('user:read'), async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'User not found' }, 404);
  return c.json({ success: true, data: row });
});

// public.users.id is a FK to auth.users(id) with no default — a profile row
// can't exist without a matching auth account. This creates that account
// directly via the Admin API (email_confirm:true, no password), bypassing
// tbwc-site's public rep-signup flow entirely, then inserts the profile row
// with the same id. If the profile insert fails, the auth user is rolled
// back so admins don't accumulate orphaned auth.users rows.
app.post('/', requirePermission('user:write'), async (c) => {
  const body = normalize(await c.req.json());
  if (!body.email) return c.json({ success: false, message: 'Email is required' }, 400);

  let authUserId: string;
  try {
    ({ id: authUserId } = await createAuthUser(c.env, body.email));
  } catch (e) {
    return c.json(
      { success: false, message: e instanceof Error ? e.message : 'Failed to create auth account' },
      502
    );
  }

  try {
    const row = await create(c.env, TABLE, { ...body, id: authUserId });
    return c.json({ success: true, data: row }, 201);
  } catch (e) {
    await deleteAuthUser(c.env, authUserId);
    throw e;
  }
});

app.put('/:id', requirePermission('user:write'), async (c) => {
  const body = normalize(await c.req.json());
  // public.users has no updated_at column.
  const row = await update(c.env, TABLE, PK, c.req.param('id'), body, { touchUpdatedAt: false });
  if (!row) return c.json({ success: false, message: 'User not found or nothing to update' }, 404);
  return c.json({ success: true, data: row });
});

app.delete('/:id', requirePermission('user:write'), async (c) => {
  const row = await remove(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'User not found' }, 404);
  return c.json({ success: true, data: row });
});

// Dev-only "log in as this user" — mints a real Supabase session for the
// target via the admin API (see supabaseAdmin.ts). Gated by canImpersonate's
// single-email check, independent of the admin role check requirePermission
// already did; never reachable in prod since ENABLE_IMPERSONATION only ever
// lives in .dev.vars.
app.post('/:id/impersonate', requirePermission('user:read'), async (c) => {
  const caller = c.get('user');
  if (!canImpersonate(c.env, caller?.email)) {
    return c.json({ success: false, message: 'Not available' }, 403);
  }
  const target = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!target) return c.json({ success: false, message: 'User not found' }, 404);
  if (!target.email) return c.json({ success: false, message: 'Target user has no email' }, 400);

  let session;
  try {
    session = await mintSessionForEmail(c.env, target.email);
  } catch (e) {
    return c.json(
      { success: false, message: e instanceof Error ? e.message : 'Failed to mint impersonation session' },
      502
    );
  }

  return c.json({
    success: true,
    data: {
      token: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      user: {
        id: target.id,
        email: target.email,
        name: [target.first_name, target.last_name].filter(Boolean).join(' ') || target.email,
      },
    },
  });
});

export default app;
