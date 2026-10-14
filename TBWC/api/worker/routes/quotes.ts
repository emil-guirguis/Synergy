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
 *
 * Line items are their own child resource (quoteGridLineSchema.ts), saved one row
 * at a time through /:id/lines[/:lineId] under their own quoteGridLine:*
 * permissions — the quote's POST/PUT no longer carry `lines`, and `total` is
 * never client-writable (always SUM(quote_line.amount)).
 */
import { Hono } from 'hono';
import { Env, execQuery, withTransaction } from '../db';
import { AuthVariables, authenticateToken, requirePermission, visibleRepListIds } from '../middleware';
import { redactRow, redactRows, stripNonEditable } from '@meterit/framework-backend/api/base/permissions';
import {
  listChildren, createChild, updateChild, deleteChild,
  ChildRowNotFoundError, ChildRowValidationError, type ChildRowsConfig, type TxQuery,
} from '@meterit/framework-backend/api/base/childRows';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { quoteSchema } from './quoteSchema';
import { quoteGridLineSchema } from './quoteGridLineSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'quote';
const PK = 'quote_id';
const [DEFAULT_SORT_FIELD, DEFAULT_SORT_ORDER] = quoteSchema.schema.defaultSortBy.split(/\s+/);
const SEARCH = ['customer_name', 'ref_number'];
const LIKE_FIELDS = likeFieldsFromSchema(quoteSchema);

// Sales rep identity always comes from here now, not the old freeform
// sales_rep text column (dropped from quoteSchema.ts — see
// scripts/import-quotes-from-folders.cjs / backfill-sales-rep-id.cjs for why
// a wrong rep match would be a real permission leak, not just cosmetic).
// `sr.name AS sales_rep` after "quote".* relies on node-postgres's row
// construction taking the LAST same-named column, so this overrides the raw
// stored value with the live join result (verified against pg 8.23) —
// null/blank for a quote whose rep was never matched, same as before.
const REP_JOIN = 'LEFT JOIN public.qb_sales_rep sr ON sr.list_id = "quote".sales_rep_list_id';
const REP_SELECT = '"quote".*, sr.name AS sales_rep';

/** True when this caller's quote:read grant is limited to their own rows. */
function ownOnly(c: any): boolean {
  return c.get('permissions')?.scopeOf('quote:read') === 'own';
}

const money = (n: number) => Math.round(n * 100) / 100;

/**
 * quote_line writes: amount is always quantity * rate, item_name always comes
 * from qb_item for a catalog pick (never trusted from the client), and the
 * quote's total is re-summed in the same transaction as every change.
 */
const LINE_CONFIG: ChildRowsConfig = {
  schema: quoteGridLineSchema,
  prepare: async (row: Record<string, any>, q: TxQuery) => {
    const quantity = Number(row.quantity ?? 1);
    const rate = Number(row.rate ?? 0);
    if (!Number.isInteger(quantity) || quantity < 0) throw new ChildRowValidationError('Qty must be a whole number');
    if (!Number.isFinite(rate)) throw new ChildRowValidationError('rate must be a number');
    const out: Record<string, any> = { ...row, quantity, rate, amount: money(quantity * rate) };
    if (row.qb_item_id != null && row.qb_item_id !== '') {
      const item = await q(`SELECT full_name FROM public.qb_item WHERE qb_item_id = $1`, [row.qb_item_id]);
      if (!item.rows[0]) throw new ChildRowValidationError('Unknown item — pick one from the search results');
      out.item_name = item.rows[0].full_name;
    } else {
      out.qb_item_id = null;
    }
    return out;
  },
  afterChange: async (q: TxQuery, quoteId: string | number) => {
    const r = await q(
      `UPDATE public.quote SET total = COALESCE((SELECT SUM(amount) FROM public.quote_line WHERE quote_id = $1), 0)
       WHERE quote_id = $1 RETURNING total`,
      [quoteId]
    );
    return { total: r.rows[0]?.total ?? null };
  },
};

/**
 * The quote a line route acts on, or null (-> 404) when it doesn't exist or
 * the caller's grant for `permission` is own-scoped and the quote isn't
 * theirs (or a managed user's) — line ownership is the parent quote's.
 */
async function quoteForLines(c: any, permission: string): Promise<any | null> {
  const existing = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!existing) return null;
  if (c.get('permissions').scopeOf(permission) === 'own') {
    if (!existing.sales_rep_list_id || !visibleRepListIds(c.get('user')).includes(existing.sales_rep_list_id)) return null;
  }
  return existing;
}

function lineError(c: any, err: unknown) {
  if (err instanceof ChildRowNotFoundError) return c.json({ success: false, message: 'Line not found' }, 404);
  if (err instanceof ChildRowValidationError) return c.json({ success: false, message: err.message }, 400);
  throw err;
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
    joins: REP_JOIN,
    selectFields: REP_SELECT,
  });
  const items = redactRows(c.get('permissions'), 'quote:read', result.rows);
  return c.json({ success: true, data: { items, total: result.pagination.total } });
});

app.get('/:id', requirePermission('quote:read'), async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'), undefined, REP_SELECT, REP_JOIN);
  if (!row) return c.json({ success: false, message: 'Quote not found' }, 404);
  if (ownOnly(c) && (!row.sales_rep_list_id || !visibleRepListIds(user).includes(row.sales_rep_list_id))) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
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
  const quoteId = await withTransaction(c.env, async (q) => {
    const r = await q(
      // No sales_rep column write — identity is sales_rep_list_id alone now,
      // resolved to a name on read via REP_JOIN, never stored as text.
      `INSERT INTO public.quote
         (customer_list_id, customer_name, txn_date, total, memo, sales_rep_list_id, status, ref_number, job_name, engineer_name, po_date)
       VALUES ($1,$2,$3,0,$4,$5,COALESCE($6, 'quote'),$7,$8,$9,$10)
       RETURNING quote_id`,
      [
        body.customer_list_id,
        customer.full_name,
        // Defaults to today — a locally-created quote has no QB sync to ever
        // backfill a date (same rationale as orders.ts's Hold for Release POST).
        body.txn_date ?? new Date().toISOString().slice(0, 10),
        body.memo ?? null,
        body.sales_rep_list_id ?? user.sales_rep_list_id ?? null,
        body.status ?? null,
        body.ref_number ?? null,
        body.job_name ?? null,
        body.engineer_name ?? null,
        body.po_date ?? null,
      ]
    );
    const newQuoteId = r.rows[0].quote_id;
    // Quote # needs the id, so it can't go in the INSERT above — backfill
    // right after in the same transaction unless the caller supplied one.
    if (!body.ref_number) {
      await q(`UPDATE public.quote SET ref_number = $1 WHERE quote_id = $2`, [`Q-${newQuoteId}`, newQuoteId]);
    }
    return newQuoteId;
  });
  const row = await findById(c.env, TABLE, PK, quoteId, undefined, REP_SELECT, REP_JOIN);
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
  if ('sales_rep_list_id' in body) cols.sales_rep_list_id = body.sales_rep_list_id;
  if ('ref_number' in body) cols.ref_number = body.ref_number;
  if ('job_name' in body) cols.job_name = body.job_name;
  if ('engineer_name' in body) cols.engineer_name = body.engineer_name;
  if ('po_date' in body) cols.po_date = body.po_date;
  const keys = Object.keys(cols);
  if (keys.length === 0) {
    return c.json({ success: false, message: 'No editable fields in request' }, 400);
  }

  const assignments = keys.map((k, i) => `${k} = $${i + 1}`);
  const values = keys.map((k) => cols[k]);
  values.push(id);
  await execQuery(c.env, `UPDATE public.${TABLE} SET ${assignments.join(', ')} WHERE ${PK} = $${values.length}`, values, 'quotes.update');

  const row = await findById(c.env, TABLE, PK, id, undefined, REP_SELECT, REP_JOIN);
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

// ---- Line items (child rows, quoteGridLine:* — see quoteGridLineSchema.ts) ----

app.get('/:id/lines', requirePermission('quoteGridLine:read'), async (c) => {
  const quote = await quoteForLines(c, 'quoteGridLine:read');
  if (!quote) return c.json({ success: false, message: 'Quote not found' }, 404);
  const rows = await listChildren(execQuery, c.env, LINE_CONFIG, quote.quote_id);
  return c.json({ success: true, data: { items: redactRows(c.get('permissions'), 'quoteGridLine:read', rows) } });
});

app.post('/:id/lines', requirePermission('quoteGridLine:create'), async (c) => {
  const quote = await quoteForLines(c, 'quoteGridLine:create');
  if (!quote) return c.json({ success: false, message: 'Quote not found' }, 404);
  const body = stripNonEditable(c.get('permissions'), 'quoteGridLine:write', await c.req.json().catch(() => ({})));
  try {
    const { row, parent } = await createChild(withTransaction, c.env, LINE_CONFIG, quote.quote_id, body);
    return c.json({ success: true, data: { item: redactRow(c.get('permissions'), 'quoteGridLine:read', row), parent } }, 201);
  } catch (err) {
    return lineError(c, err);
  }
});

app.put('/:id/lines/:lineId', requirePermission('quoteGridLine:write'), async (c) => {
  const quote = await quoteForLines(c, 'quoteGridLine:write');
  if (!quote) return c.json({ success: false, message: 'Quote not found' }, 404);
  const body = stripNonEditable(c.get('permissions'), 'quoteGridLine:write', await c.req.json().catch(() => ({})));
  try {
    const { row, parent } = await updateChild(withTransaction, c.env, LINE_CONFIG, quote.quote_id, c.req.param('lineId'), body);
    return c.json({ success: true, data: { item: redactRow(c.get('permissions'), 'quoteGridLine:read', row), parent } });
  } catch (err) {
    return lineError(c, err);
  }
});

app.delete('/:id/lines/:lineId', requirePermission('quoteGridLine:delete'), async (c) => {
  const quote = await quoteForLines(c, 'quoteGridLine:delete');
  if (!quote) return c.json({ success: false, message: 'Quote not found' }, 404);
  try {
    const { parent } = await deleteChild(withTransaction, c.env, LINE_CONFIG, quote.quote_id, c.req.param('lineId'));
    return c.json({ success: true, data: { parent } });
  } catch (err) {
    return lineError(c, err);
  }
});

export default app;
