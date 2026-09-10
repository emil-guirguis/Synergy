/**
 * Inventory (product catalog). Table public.qb_item, PK qb_item_id — the
 * QB-synced item list. Reads: any approved user.
 *
 * WRITES ARE AN ALLOWLIST, NOT A CRUD MODULE. Items exist only via the
 * QuickBooks sync, so POST/DELETE still 405 and PUT writes exactly the columns
 * in PUT_ALLOWLIST — everything else in the body is dropped on the floor. That
 * keeps the read-only freeze on every QB-owned field (name, price, desc…) and
 * on the TBWC-owned columns from migration 012 that are still being verified,
 * while letting the kit fields from migration 028 be edited. Adding a column
 * here is a deliberate act: put it in PUT_ALLOWLIST and drop its readOnly in
 * inventorySchema.ts, in that order.
 *
 * Two writes sit outside the record PUT because they are their own workflows:
 *   PATCH /:id/image      — thumbnail review verdict (migration 027).
 *   PUT   /:id/kit-items  — the contents of a kit (migration 028), replaced as
 *                           a set; the grid owns the whole list, not rows.
 */
import { Hono } from 'hono';
import { Env, execQuery, withTransaction } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';
import { findAll, findById, update, whereFromQuery, likeFieldsFromSchema, NOT_NULL } from '../crud';
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
  // hasImage is a synthetic filter — "does this row have a thumbnail at all",
  // which is the question when working through the catalog, and no single
  // image_status value answers it (auto and approved both have a picture;
  // pending, rejected and none don't). Keep it out of whereFromQuery's generic
  // pass and turn it into the NULL check below.
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS, extraReserved: ['hasImage'] });
  const where: Record<string, any> = { ...fieldWhere };
  if (q.hasImage === 'true') where.image_url = NOT_NULL;
  if (q.hasImage === 'false') where.image_url = null;
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

/**
 * Image review verdict. Admin only.
 *
 * 'approved' / 'rejected' are terminal as far as the fetch script is concerned —
 * it filters both out of its work set — so this is what stops a re-run from
 * undoing a human's decision. Rejecting also clears image_url, because a
 * rejected picture is a wrong picture and leaving it in the column risks it
 * reaching the printout through some other query.
 */
const IMAGE_VERDICTS = ['approved', 'rejected', 'auto', 'pending', 'none'] as const;

app.patch('/:id/image', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const status = body?.image_status;
  if (!IMAGE_VERDICTS.includes(status)) {
    return c.json({ success: false, message: `image_status must be one of ${IMAGE_VERDICTS.join(', ')}` }, 400);
  }

  // A hand-supplied URL is allowed (paste the right picture when the machine
  // got it wrong), but only an https one — this value ends up in an <img src>
  // on a rep-facing page and in the print pipeline.
  const manualUrl = typeof body.image_url === 'string' ? body.image_url.trim() : undefined;
  if (manualUrl !== undefined && manualUrl !== '' && !/^https:\/\//i.test(manualUrl)) {
    return c.json({ success: false, message: 'image_url must be an https URL' }, 400);
  }

  const clearUrl = status === 'rejected' || manualUrl === '';
  const result = await execQuery(
    c.env,
    `UPDATE qb_item
        SET image_status = $2,
            image_url = CASE WHEN $3::boolean THEN NULL
                             WHEN $4::text IS NOT NULL THEN $4::text
                             ELSE image_url END,
            image_source = CASE WHEN $4::text IS NOT NULL THEN 'manual' ELSE image_source END,
            image_confidence = CASE WHEN $4::text IS NOT NULL THEN 100 ELSE image_confidence END,
            image_updated_at = now()
      WHERE qb_item_id = $1::bigint
      RETURNING qb_item_id, image_url, image_status, image_source, image_confidence, image_source_url`,
    [c.req.param('id'), status, clearUrl, manualUrl || null],
    'inventory image verdict'
  );

  if (!result.rows.length) return c.json({ success: false, message: 'Inventory item not found' }, 404);
  return c.json({ success: true, data: result.rows[0] });
});

/**
 * A kit's lines with the child item joined in, so the grid can render one
 * without a round trip per row. `item_on_hand` is QuickBooks' stock level
 * (migration 029) and is NULL for item types QB does not stock-track — the UI
 * must show that as blank, not 0.
 */
const KIT_ITEMS_SELECT = `SELECT k.kit_items_id, k.qb_item_id, k.item_id, k.group_id, k.group_desc, k.order_by, k.qty, k.required,
            i.name AS item_name, i.sales_desc AS item_desc, i.sales_price AS item_price,
            i.image_url AS item_image_url, i.quantity_on_hand AS item_on_hand
       FROM kit_items k
       JOIN qb_item i ON i.qb_item_id = k.item_id
      WHERE k.qb_item_id = $1::bigint
      ORDER BY k.group_id NULLS FIRST, k.order_by, k.kit_items_id`;

/**
 * Kit contents. `qb_item_id` is the KIT, `item_id` the child line — both FK to
 * qb_item (migration 028). Readable by any approved user: reps need to see
 * what is in a kit before quoting it.
 */
app.get('/:id/kit-items', async (c) => {
  const rows = await execQuery(
    c.env,
    KIT_ITEMS_SELECT,
    [c.req.param('id')],
    'inventory kit items'
  );
  return c.json({ success: true, data: { items: rows.rows } });
});

/**
 * Replace a kit's contents wholesale. Admin only.
 *
 * Replace-all rather than per-row CRUD because the grid's unit of work is the
 * whole ordering: one drag rewrites `order_by` on every row below it and can
 * move a row between groups, so sending the list as it now stands is both
 * simpler and atomic. Same shape as the quote/quote_line save (quotes.ts).
 * `order_by` is assigned server-side from array position within each group —
 * the client's job is the order, not the numbering.
 */
app.put('/:id/kit-items', requireAdmin, async (c) => {
  const kitId = c.req.param('id');
  const kit = await execQuery(c.env, `SELECT qb_item_id, type FROM qb_item WHERE qb_item_id = $1::bigint`, [kitId]);
  if (!kit.rows.length) return c.json({ success: false, message: 'Inventory item not found' }, 404);

  const body = await c.req.json().catch(() => ({} as any));
  const raw = Array.isArray(body?.items) ? body.items : null;
  if (!raw) return c.json({ success: false, message: 'items must be an array' }, 400);

  const kitIdNum = Number(kitId);
  const lines: {
    item_id: number; group_id: number | null; group_desc: string | null;
    qty: number; required: boolean;
  }[] = [];
  for (const l of raw) {
    const itemId = Number(l?.item_id);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return c.json({ success: false, message: 'every line needs a numeric item_id' }, 400);
    }
    // Omitted qty means one of the item — the column's own default. Mirrors
    // kit_items_qty_check so a bad value is a 400, not a constraint violation.
    const qty = l?.qty === undefined || l?.qty === null || l?.qty === '' ? 1 : Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return c.json({ success: false, message: 'qty must be a number greater than zero' }, 400);
    }
    // Mirrors the kit_items_no_self_check constraint, so a bad payload comes
    // back as a 400 and not a 500 out of the driver.
    if (itemId === kitIdNum) {
      return c.json({ success: false, message: 'A kit cannot contain itself.' }, 400);
    }
    const group = l?.group_id === null || l?.group_id === undefined || l.group_id === '' ? null : Number(l.group_id);
    if (group !== null && !Number.isInteger(group)) {
      return c.json({ success: false, message: 'group_id must be a whole number or empty' }, 400);
    }
    const desc = typeof l?.group_desc === 'string' && l.group_desc.trim() !== '' ? l.group_desc.trim() : null;
    // Required unless the client explicitly says otherwise — the column's own
    // default, and what a kit line means when nobody has thought about it.
    lines.push({ item_id: itemId, group_id: group, group_desc: desc, qty, required: l?.required !== false });
  }

  // Every child must be a real catalog row. Checked up front so a typo'd id
  // fails as a 400 instead of surfacing as an FK violation mid-transaction.
  if (lines.length) {
    const ids = [...new Set(lines.map((l) => l.item_id))];
    const found = await execQuery(
      c.env,
      `SELECT qb_item_id FROM qb_item WHERE qb_item_id = ANY($1::bigint[])`,
      [ids],
      'inventory kit items validate'
    );
    if (found.rows.length !== ids.length) {
      const have = new Set(found.rows.map((r: any) => Number(r.qb_item_id)));
      const missing = ids.filter((id) => !have.has(id));
      return c.json({ success: false, message: `Unknown inventory item(s): ${missing.join(', ')}` }, 400);
    }
  }

  // group_desc is denormalised onto every line (migration 031), so one group
  // must not end up with two labels. First non-empty one in the list wins and
  // is stamped on the whole group — including lines the client sent blank,
  // which is what dragging a row into a named group produces.
  const groupNames = new Map<string, string | null>();
  for (const l of lines) {
    const key = String(l.group_id);
    if (!groupNames.get(key) && l.group_desc) groupNames.set(key, l.group_desc);
  }
  for (const l of lines) l.group_desc = groupNames.get(String(l.group_id)) ?? null;

  await withTransaction(c.env, async (q) => {
    await q(`DELETE FROM kit_items WHERE qb_item_id = $1::bigint`, [kitId]);
    // order_by counts within a group, so each group reads 0,1,2… on its own —
    // the grid groups before it sorts, and a global counter would leave
    // confusing gaps in every group after the first.
    const seq = new Map<string, number>();
    for (const l of lines) {
      const key = String(l.group_id);
      const n = seq.get(key) ?? 0;
      seq.set(key, n + 1);
      await q(
        `INSERT INTO kit_items (qb_item_id, item_id, group_id, group_desc, order_by, qty, required)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [kitId, l.item_id, l.group_id, l.group_desc, n, l.qty, l.required]
      );
    }
  });

  // Return the saved list in its stored shape so the panel can adopt the
  // server's row ids and ordering instead of guessing at them.
  const rows = await execQuery(
    c.env,
    KIT_ITEMS_SELECT,
    [kitId],
    'inventory kit items saved'
  );
  return c.json({ success: true, data: { items: rows.rows } });
});

/**
 * Record update, restricted to the TBWC-owned kit fields. Admin only.
 *
 * Not a general CRUD update: anything outside PUT_ALLOWLIST is ignored
 * silently rather than rejected, because the form posts the whole record back
 * (every QB-owned field included) and a 400 on fields the user never touched
 * would make the form unsaveable. The schema marks those fields readOnly so
 * they are never editable in the UI either — this is the backstop.
 */
const PUT_ALLOWLIST = ['type', 'notes'] as const;
const ITEM_TYPES = ['kit', 'item'];

app.put('/:id', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const data: Record<string, any> = {};
  for (const col of PUT_ALLOWLIST) {
    if (body[col] !== undefined) data[col] = body[col];
  }

  if (data.type !== undefined && !ITEM_TYPES.includes(data.type)) {
    return c.json({ success: false, message: `type must be one of ${ITEM_TYPES.join(', ')}` }, 400);
  }
  // '' from an empty textarea means "no notes", not an empty string to store.
  if (typeof data.notes === 'string' && data.notes.trim() === '') data.notes = null;

  if (!Object.keys(data).length) {
    return c.json({ success: false, message: `Nothing editable in the payload (editable: ${PUT_ALLOWLIST.join(', ')}).` }, 400);
  }

  // qb_item has no updated_at column (it is a QB staging table — synced_at is
  // the sync's own clock), so the helper must not append one.
  const row = await update(c.env, TABLE, PK, c.req.param('id'), data, { touchUpdatedAt: false });
  if (!row) return c.json({ success: false, message: 'Inventory item not found' }, 404);
  return c.json({ success: true, data: row });
});

app.post('/', requireAdmin, (c) =>
  c.json({ success: false, message: 'Inventory items are created by the QuickBooks sync and cannot be created here.' }, 405));
app.delete('/:id', requireAdmin, (c) =>
  c.json({ success: false, message: 'Inventory items are managed by the QuickBooks sync and cannot be deleted here.' }, 405));

export default app;
