/**
 * Payments (QuickBooks ReceivePayment) — read-only. Table public.qb_payment,
 * PK qb_payment_id. Populated by the QBWC pull (ReceivePaymentQueryRq); the
 * source of truth is QuickBooks, so this module exposes list + detail only.
 * No writes: edits here would be clobbered on the next sync.
 *
 * Unlike qb_customer/qb_invoice, qb_payment has no qb_deleted_at column (not
 * part of the txnDeleted.ts sweep — see that file), so there is nothing to
 * filter on for soft-deletes here.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { paymentsSchema } from './paymentsSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('payment:read'));

const TABLE = 'qb_payment';
const PK = 'qb_payment_id';
const SEARCH = ['ref_number', 'customer_name'];
const LIKE_FIELDS = likeFieldsFromSchema(paymentsSchema);

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
    orderBy: q.sortBy ? undefined : `"${TABLE}".txn_date DESC NULLS LAST`,
    where,
    whereLike,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Payment not found' }, 404);
  return c.json({ success: true, data: row });
});

export default app;
