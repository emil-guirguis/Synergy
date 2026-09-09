/**
 * Invoices (QuickBooks) — read-only. Table public.qb_invoice, PK qb_invoice_id.
 * Populated by the QBWC pull (InvoiceQueryRq); the source of truth is QuickBooks,
 * so this module exposes list + detail only. Admin-only.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { invoicesSchema } from './invoicesSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requireAdmin);

const TABLE = 'qb_invoice';
const PK = 'qb_invoice_id';
const SEARCH = ['ref_number', 'customer_name'];
const LIKE_FIELDS = likeFieldsFromSchema(invoicesSchema);

app.get('/', async (c) => {
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
    orderBy: q.sortBy ? undefined : `"${TABLE}".txn_date DESC`,
    where,
    whereLike,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Invoice not found' }, 404);
  return c.json({ success: true, data: row });
});

export default app;
