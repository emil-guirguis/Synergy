/**
 * Quotes — backed by public.quote (PK quote_id). TBWC-owned, local-only: not
 * synced with (or pushed to) QuickBooks at all — see migration 070, which
 * renamed this back from the old QB-Estimate-backed Estimates module. Every
 * field is directly writable; there's no QB-ownership split to respect
 * anymore.
 *
 * Visibility mirrors orders: admins see every quote; everyone else sees
 * their own plus every user they manage's (public.user_manager, flat one
 * level — see middleware.ts's visibleRepListIds), read-only — no
 * quote:write grant for non-admins (migration 056).
 */
import { Hono } from 'hono';
import { Env, execQuery, withTransaction } from '../db';
import { AuthVariables, authenticateToken, requirePermission, visibleRepListIds } from '../middleware';
import { redactRow, redactRows } from '@meterit/framework-backend/api/base/permissions';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { quoteSchema } from './quoteSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'quote';
const PK = 'quote_id';
const [DEFAULT_SORT_FIELD, DEFAULT_SORT_ORDER] = quoteSchema.schema.defaultSortBy.split(/\s+/);
const SEARCH = ['customer_name', 'ref_number'];
const LIKE_FIELDS = likeFieldsFromSchema(quoteSchema);

/** True when this caller's quote:read grant is limited to their own rows. */
function ownOnly(c: any): boolean {
  return c.get('permissions')?.scopeOf('quote:read') === 'own';
}

type TxQuery = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

/** Line shape PickableLineItemsGrid reads/writes — see quoteSchema.ts's lineItemPicker. */
function toLineRow(l: any, order: number) {
  return [
    Number.isFinite(Number(l?.itemValue)) ? Number(l.itemValue) : null,
    l?.item ?? null,
    l?.desc ?? null,
    Number(l?.quantity) || 0,
    Number(l?.rate) || 0,
    (Number(l?.quantity) || 0) * (Number(l?.rate) || 0),
    order,
  ];
}

/** Replaces every quote_line row for `quoteId` with `lines` and recomputes quote.total. */
async function replaceLines(q: TxQuery, quoteId: number | string, lines: any[]): Promise<void> {
  await q(`DELETE FROM public.quote_line WHERE quote_id = $1`, [quoteId]);
  for (let i = 0; i < lines.length; i++) {
    const [qbItemId, item, desc, quantity, rate, amount, order] = toLineRow(lines[i], i);
    await q(
      `INSERT INTO public.quote_line (quote_id, qb_item_id, item_name, description, quantity, rate, amount, line_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [quoteId, qbItemId, item, desc, quantity, rate, amount, order]
    );
  }
  await q(
    `UPDATE public.quote SET total = COALESCE((SELECT SUM(amount) FROM public.quote_line WHERE quote_id = $1), 0)
     WHERE quote_id = $1`,
    [quoteId]
  );
}

/** Quote lines in the shape the frontend's PickableLineItemsGrid expects. */
async function fetchLines(env: Env, quoteId: number | string): Promise<any[]> {
  const r = await execQuery(
    env,
    `SELECT qb_item_id, item_name, description, quantity, rate, amount
       FROM public.quote_line WHERE quote_id = $1 ORDER BY line_order ASC`,
    [quoteId],
    'quotes.fetchLines'
  );
  return r.rows.map((row) => ({
    item: row.item_name,
    itemValue: row.qb_item_id,
    desc: row.description,
    quantity: row.quantity,
    rate: row.rate,
    amount: row.amount,
  }));
}

/**
 * Confirms `listId` is a real, non-deleted QuickBooks customer and returns
 * its authoritative name — server-side backstop for the picker on the
 * create/edit form (ReferenceSearchField only ever commits a value the user
 * picked from a live /customers search, but nothing stopped a stale or
 * hand-crafted request from naming a customer that doesn't exist, or one QB
 * has since deleted).
 */
async function resolveCustomer(env: Env, listId: string): Promise<{ full_name: string | null } | null> {
  const r = await execQuery(
    env,
    `SELECT full_name FROM public.qb_customer WHERE list_id = $1 AND qb_deleted_at IS NULL`,
    [listId],
    'quotes.resolveCustomer'
  );
  return r.rows[0] ?? null;
}

/**
 * Overwrites each row's sales_rep with the live qb_sales_rep.name for its
 * sales_rep_list_id (falls back to the stored string when unlinked). The
 * stored column is write-once at creation (see POST below) and can go stale
 * or — for rows inherited from the old QB-Estimate sync (migration 070) —
 * hold the QB SalesRepRef's initials rather than the rep's spelled-out name
 * (same initials-vs-name gap fixed for search in migration/salesRep.ts).
 */
async function resolveSalesRepNames(env: Env, rows: any[]): Promise<void> {
  const listIds = [...new Set(rows.map((r) => r.sales_rep_list_id).filter(Boolean))];
  if (listIds.length === 0) return;
  const r = await execQuery(
    env,
    `SELECT list_id, name FROM public.qb_sales_rep WHERE list_id IN (${listIds.map((_, i) => `$${i + 1}`).join(', ')})`,
    listIds,
    'quotes.resolveSalesRepNames'
  );
  const nameByListId = new Map(r.rows.map((row) => [row.list_id, row.name]));
  for (const row of rows) {
    row.sales_rep = nameByListId.get(row.sales_rep_list_id) ?? row.sales_rep;
  }
}

app.get('/', requirePermission('quote:read'), async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  const { where, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS });
  // IN-list (own rep + every managed user's rep), not a single exact match —
  // goes through whereRaw rather than `where` (see orders.ts for the same
  // pattern/rationale).
  const whereRaw: { sql: string; params?: any[] }[] = [];
  if (ownOnly(c)) {
    const repIds = visibleRepListIds(user);
    whereRaw.push(
      repIds.length > 0
        ? { sql: `sales_rep_list_id IN (${repIds.map(() => '?').join(', ')})`, params: repIds }
        : { sql: '1 = 0' }
    );
  }
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    sortBy: q.sortBy || DEFAULT_SORT_FIELD,
    sortOrder: q.sortOrder || DEFAULT_SORT_ORDER,
    where,
    whereLike,
    whereRaw,
  });
  await resolveSalesRepNames(c.env, result.rows);
  const items = redactRows(c.get('permissions'), 'quote:read', result.rows);
  return c.json({ success: true, data: { items, total: result.pagination.total } });
});

app.get('/:id', requirePermission('quote:read'), async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Quote not found' }, 404);
  if (ownOnly(c) && (!row.sales_rep_list_id || !visibleRepListIds(user).includes(row.sales_rep_list_id))) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  row.lines = await fetchLines(c.env, row.quote_id);
  await resolveSalesRepNames(c.env, [row]);
  return c.json({ success: true, data: redactRow(c.get('permissions'), 'quote:read', row) });
});

app.post('/', requirePermission('quote:write'), async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  if (!body.customer_list_id) {
    return c.json({ success: false, message: 'customer_list_id is required' }, 400);
  }
  const customer = await resolveCustomer(c.env, body.customer_list_id);
  if (!customer) {
    return c.json({ success: false, message: 'Unknown customer — pick one from the search results' }, 400);
  }
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const quoteId = await withTransaction(c.env, async (q) => {
    const r = await q(
      `INSERT INTO public.quote
         (customer_list_id, customer_name, txn_date, total, memo, sales_rep_list_id, sales_rep, status, ref_number)
       VALUES ($1,$2,$3,0,$4,$5,$6,COALESCE($7, 'quote'),$8)
       RETURNING quote_id`,
      [
        body.customer_list_id,
        customer.full_name,
        // Defaults to today — a locally-created quote has no QB sync to ever
        // backfill a date (same rationale as orders.ts's Hold for Release POST).
        body.txn_date ?? new Date().toISOString().slice(0, 10),
        body.memo ?? null,
        body.sales_rep_list_id ?? user.sales_rep_list_id ?? null,
        body.sales_rep ?? user.sales_rep_name ?? null,
        body.status ?? null,
        body.ref_number ?? null,
      ]
    );
    const quoteId = r.rows[0].quote_id;
    if (lines.length > 0) await replaceLines(q, quoteId, lines);
    return quoteId;
  });
  const row = await findById(c.env, TABLE, PK, quoteId);
  row.lines = await fetchLines(c.env, quoteId);
  return c.json({ success: true, data: redactRow(c.get('permissions'), 'quote:read', row) }, 201);
});

app.put('/:id', requirePermission('quote:write'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Quote not found' }, 404);
  // No role grants own-scoped quote:write today (migration 056), but the
  // scope is editable per role, so honour it here rather than assuming write
  // implies every row — same defensive check as orders.ts's PUT.
  if (c.get('permissions').scopeOf('quote:write') === 'own') {
    const user = c.get('user');
    if (!existing.sales_rep_list_id || !visibleRepListIds(user).includes(existing.sales_rep_list_id)) {
      return c.json({ success: false, message: 'Not found' }, 404);
    }
  }

  const body = await c.req.json();
  const cols: Record<string, any> = {};

  if ('customer_list_id' in body) {
    const customer = await resolveCustomer(c.env, body.customer_list_id);
    if (!customer) {
      return c.json({ success: false, message: 'Unknown customer — pick one from the search results' }, 400);
    }
    cols.customer_list_id = body.customer_list_id;
    cols.customer_name = customer.full_name;
  }
  if ('txn_date' in body) cols.txn_date = body.txn_date;
  if ('memo' in body) cols.memo = body.memo;
  if ('status' in body) cols.status = body.status;
  if ('ref_number' in body) cols.ref_number = body.ref_number;
  const newLines = 'lines' in body ? (Array.isArray(body.lines) ? body.lines : []) : null;
  const keys = Object.keys(cols);
  if (keys.length === 0 && newLines === null) {
    return c.json({ success: false, message: 'No editable fields in request' }, 400);
  }

  await withTransaction(c.env, async (q) => {
    if (keys.length > 0) {
      const assignments = keys.map((k, i) => `${k} = $${i + 1}`);
      const values = keys.map((k) => cols[k]);
      values.push(id);
      await q(`UPDATE public.${TABLE} SET ${assignments.join(', ')} WHERE ${PK} = $${values.length}`, values);
    }
    if (newLines !== null) await replaceLines(q, id, newLines);
  });

  const row = await findById(c.env, TABLE, PK, id);
  row.lines = await fetchLines(c.env, id);
  return c.json({ success: true, data: row });
});

app.delete('/:id', requirePermission('quote:delete'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Quote not found' }, 404);
  // Same own-scope guard as PUT: quote:delete can be scoped 'own' (reps/
  // customers, migration 075), so a rep's id can't be used to probe or
  // remove another rep's quote.
  if (c.get('permissions').scopeOf('quote:delete') === 'own') {
    const user = c.get('user');
    if (!existing.sales_rep_list_id || !visibleRepListIds(user).includes(existing.sales_rep_list_id)) {
      return c.json({ success: false, message: 'Not found' }, 404);
    }
  }
  const r = await execQuery(c.env, `DELETE FROM public.${TABLE} WHERE ${PK} = $1 RETURNING *`, [id], 'quotes.delete');
  return c.json({ success: true, data: r.rows[0] });
});

export default app;
