/**
 * Inventory (product catalog) — read-only. Table public.qb_item, PK qb_item_id
 * — the QB-synced item list. Temporarily read-only end to end (GET only)
 * while the qb_item rebase is still being verified; PUT/POST/DELETE all
 * reply 405. See inventorySchema.ts for the field-level readOnly mirror.
 * Reads: any approved user.
 */
import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { inventorySchema } from './inventorySchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'qb_item';
const PK = 'qb_item_id';
const SEARCH = ['name', 'full_name', 'sales_desc', 'category', 'upc_code'];
// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues).
const LIKE_FIELDS = likeFieldsFromSchema(inventorySchema);

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
    orderBy: q.sortBy ? undefined : `"${TABLE}".name ASC`,
    where,
    whereLike,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Inventory item not found' }, 404);
  return c.json({ success: true, data: row });
});

// Read-only for now: items exist only via the QuickBooks sync, and edits to
// the TBWC-owned columns are disabled until the qb_item rebase is verified.
app.put('/:id', requireAdmin, (c) =>
  c.json({ success: false, message: 'Inventory is read-only for now.' }, 405));
app.post('/', requireAdmin, (c) =>
  c.json({ success: false, message: 'Inventory items are created by the QuickBooks sync and cannot be created here.' }, 405));
app.delete('/:id', requireAdmin, (c) =>
  c.json({ success: false, message: 'Inventory items are managed by the QuickBooks sync and cannot be deleted here.' }, 405));

export default app;
