/**
 * Quotes CRUD. Header table public.quote (PK quote_id) + line items
 * public.quote_line (PK quote_line_id, FK quote_id ON DELETE CASCADE).
 *
 * Visibility mirrors orders (Worker connects at service level, bypasses RLS):
 *   - admins / can_see_orders -> every quote
 *   - a rep                    -> only their own (rep_id = user.id)
 * Create: any approved user (rep_id forced to caller unless admin overrides).
 * Update/Delete: owner or admin.
 *
 * Totals are always recomputed server-side from the lines — the client never
 * dictates ext_price/subtotal/total.
 */
import { Hono } from 'hono';
import { Env, execQuery, withTransaction } from '../db';
import { AuthVariables, authenticateToken } from '../middleware';
import { findAll, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { quoteSchema } from './quoteSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'quote';
const PK = 'quote_id';
const SEARCH = ['quote_number', 'project_name', 'customer', 'poc'];
// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — 'status' is a fixed-options select, so it's exact-match).
const LIKE_FIELDS = likeFieldsFromSchema(quoteSchema);

function canSeeAll(user: any): boolean {
  return !!(user?.is_admin || user?.can_see_orders);
}

function num(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

interface LineInput {
  qb_item_id?: number | null;
  part_number?: string | null;
  description?: string | null;
  qty?: number | string;
  unit_price?: number | string;
}

/** Normalise + price the incoming lines, dropping empty rows. */
function normalizeLines(raw: any): { lines: any[]; subtotal: number } {
  const arr: LineInput[] = Array.isArray(raw) ? raw : [];
  let subtotal = 0;
  const lines = arr
    .filter((l) => l && (l.qb_item_id != null || (l.part_number && String(l.part_number).trim() !== '') || num(l.qty) > 0))
    .map((l, i) => {
      const qty = num(l.qty);
      const unit_price = num(l.unit_price);
      const ext_price = Math.round(qty * unit_price * 100) / 100;
      subtotal += ext_price;
      return {
        qb_item_id: l.qb_item_id ?? null,
        part_number: l.part_number ?? null,
        description: l.description ?? null,
        qty,
        unit_price,
        ext_price,
        line_order: i,
      };
    });
  subtotal = Math.round(subtotal * 100) / 100;
  return { lines, subtotal };
}

app.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS });
  // Field filters first, then the security scope — rep_id always wins so a rep
  // can't widen their own visibility via a crafted query param.
  const where = { ...fieldWhere, ...(canSeeAll(user) ? {} : { rep_id: user.id }) };
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    whereLike,
    where,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const head = await execQuery(c.env, `SELECT * FROM "quote" WHERE quote_id = $1`, [id]);
  const quote = head.rows[0];
  if (!quote) return c.json({ success: false, message: 'Quote not found' }, 404);
  if (!canSeeAll(user) && quote.rep_id !== user.id) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  const lines = await execQuery(
    c.env,
    `SELECT * FROM "quote_line" WHERE quote_id = $1 ORDER BY line_order ASC, quote_line_id ASC`,
    [id]
  );
  return c.json({ success: true, data: { ...quote, lines: lines.rows } });
});

app.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { lines, subtotal } = normalizeLines(body.lines);
  const tax = num(body.tax);
  const freight = num(body.freight);
  const total = Math.round((subtotal + tax + freight) * 100) / 100;
  // A rep owns the quotes they create; only admins may assign another rep.
  const rep_id = user.is_admin && body.rep_id ? body.rep_id : user.id;
  const rep = user.is_admin && body.rep != null ? body.rep : (body.rep ?? user.name ?? null);

  const created = await withTransaction(c.env, async (q) => {
    const h = await q(
      `INSERT INTO "quote"
         (quote_number, project_name, customer, street_address, city_state_zip, poc, cc_email,
          status, rep, rep_id, notes, subtotal, tax, freight, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        body.quote_number ?? null, body.project_name ?? null, body.customer ?? null,
        body.street_address ?? null, body.city_state_zip ?? null, body.poc ?? null, body.cc_email ?? null,
        body.status ?? 'draft', rep, rep_id, body.notes ?? null, subtotal, tax, freight, total,
      ]
    );
    const quote = h.rows[0];
    for (const l of lines) {
      await q(
        `INSERT INTO "quote_line"
           (quote_id, qb_item_id, part_number, description, qty, unit_price, ext_price, line_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [quote.quote_id, l.qb_item_id, l.part_number, l.description, l.qty, l.unit_price, l.ext_price, l.line_order]
      );
    }
    return { ...quote, lines };
  });

  return c.json({ success: true, data: created }, 201);
});

app.put('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const existing = await execQuery(c.env, `SELECT rep_id FROM "quote" WHERE quote_id = $1`, [id]);
  if (existing.rows.length === 0) return c.json({ success: false, message: 'Quote not found' }, 404);
  if (!user.is_admin && existing.rows[0].rep_id !== user.id) {
    return c.json({ success: false, message: 'Not allowed' }, 403);
  }

  const body = await c.req.json();
  const hasLines = Array.isArray(body.lines);
  const { lines, subtotal } = normalizeLines(body.lines);

  const updated = await withTransaction(c.env, async (q) => {
    const cur = (await q(`SELECT tax, freight, subtotal FROM "quote" WHERE quote_id = $1`, [id])).rows[0] || {};

    // Build the header update from recognised columns only (skip undefined).
    const cols: Record<string, any> = {
      quote_number: body.quote_number, project_name: body.project_name, customer: body.customer,
      street_address: body.street_address, city_state_zip: body.city_state_zip, poc: body.poc,
      cc_email: body.cc_email, status: body.status, notes: body.notes,
    };
    if (user.is_admin) {
      if (body.rep !== undefined) cols.rep = body.rep;
      if (body.rep_id !== undefined) cols.rep_id = body.rep_id;
    }
    // Resolve the three total inputs from body (if given) else current row.
    const finalTax = body.tax != null ? num(body.tax) : num(cur.tax);
    const finalFreight = body.freight != null ? num(body.freight) : num(cur.freight);
    const finalSubtotal = hasLines ? subtotal : num(cur.subtotal);
    if (body.tax != null) cols.tax = finalTax;
    if (body.freight != null) cols.freight = finalFreight;
    if (hasLines) cols.subtotal = finalSubtotal;
    cols.total = Math.round((finalSubtotal + finalTax + finalFreight) * 100) / 100;
    cols.updated_at = new Date().toISOString();

    const setKeys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    const assignments = setKeys.map((k, i) => `${k} = $${i + 1}`);
    const values = setKeys.map((k) => cols[k]);
    values.push(id);
    const h = await q(
      `UPDATE "quote" SET ${assignments.join(', ')} WHERE quote_id = $${values.length} RETURNING *`,
      values
    );
    const quote = h.rows[0];

    if (hasLines) {
      await q(`DELETE FROM "quote_line" WHERE quote_id = $1`, [id]);
      for (const l of lines) {
        await q(
          `INSERT INTO "quote_line"
             (quote_id, qb_item_id, part_number, description, qty, unit_price, ext_price, line_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, l.qb_item_id, l.part_number, l.description, l.qty, l.unit_price, l.ext_price, l.line_order]
        );
      }
      return { ...quote, lines };
    }
    const existingLines = await q(
      `SELECT * FROM "quote_line" WHERE quote_id = $1 ORDER BY line_order ASC, quote_line_id ASC`,
      [id]
    );
    return { ...quote, lines: existingLines.rows };
  });

  return c.json({ success: true, data: updated });
});

app.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const existing = await execQuery(c.env, `SELECT rep_id FROM "quote" WHERE quote_id = $1`, [id]);
  if (existing.rows.length === 0) return c.json({ success: false, message: 'Quote not found' }, 404);
  if (!user.is_admin && existing.rows[0].rep_id !== user.id) {
    return c.json({ success: false, message: 'Not allowed' }, 403);
  }
  // quote_line rows cascade via FK ON DELETE CASCADE.
  const r = await execQuery(c.env, `DELETE FROM "quote" WHERE quote_id = $1 RETURNING *`, [id]);
  return c.json({ success: true, data: r.rows[0] });
});

export default app;
