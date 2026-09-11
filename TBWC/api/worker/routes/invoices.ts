/**
 * Invoices (QuickBooks) — read-only. Table public.qb_invoice, PK qb_invoice_id.
 * Populated by the QBWC pull (InvoiceQueryRq); the source of truth is QuickBooks,
 * so this module exposes list + detail only — nobody writes here.
 *
 * Admins see every invoice; a rep sees only their own. Ownership is
 * qb_invoice.sales_rep_list_id (migration 033), taken straight off QB's
 * SalesRepRef on InvoiceRet by the sync — no join to the sales order, because
 * InvoiceQueryRq is not sent with IncludeLinkedTxns and linked_txn is '[]'
 * on every row. ~350 of 7.8k invoices carry no rep: invisible to reps,
 * visible to admins.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken } from '../middleware';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { invoicesSchema } from './invoicesSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'qb_invoice';
const PK = 'qb_invoice_id';
const SEARCH = ['ref_number', 'customer_name'];
const LIKE_FIELDS = likeFieldsFromSchema(invoicesSchema);

function canSeeAll(user: any): boolean {
  return !!user?.is_admin;
}

/**
 * The rep scope, or null for an admin. A rep with no linked qb_sales_rep gets a
 * value that can never match a real list_id rather than an IS NULL scope, which
 * would hand them every invoice with no linked order yet (mirrors orders.ts).
 */
function repScope(user: any): string | null {
  return canSeeAll(user) ? null : (user.sales_rep_list_id ?? '__unlinked__');
}

app.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS });
  // Field filters first, then the scope — it always wins, so a rep can't widen
  // their own visibility with a crafted sales_rep_list_id query param.
  const scope = repScope(user);
  const where: Record<string, any> = {
    ...fieldWhere,
    ...(scope === null ? {} : { sales_rep_list_id: scope }),
  };
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    orderBy: q.sortBy ? undefined : `"${TABLE}".txn_date DESC`,
    where,
    whereLike,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Invoice not found' }, 404);
  // 404 rather than 403 — a rep shouldn't be able to probe which invoice ids
  // exist. Compared against the scope value, so an unlinked rep matches nothing.
  const scope = repScope(user);
  if (scope !== null && row.sales_rep_list_id !== scope) {
    return c.json({ success: false, message: 'Invoice not found' }, 404);
  }
  return c.json({ success: true, data: row });
});

export default app;
