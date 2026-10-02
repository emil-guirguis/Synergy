/**
 * Estimates — backed by public.qb_estimate (PK qb_estimate_id), the QB-synced
 * staging table for QuickBooks' Estimate (quote) object.
 *
 * Two lifecycles share this table, told apart by txn_id:
 *   - Synced from QB (txn_id set) — every editable field (memo, lines) is
 *     QB-owned, so a PUT never writes the column directly. It stages the edit
 *     in qbwc_push_queue with status='draft' (queueFieldPush's default is
 *     'pending'; this route always passes 'draft' explicitly). A 'draft' row
 *     is excluded from qbwc/pushQueue.ts's pendingPushes(), so
 *     estimate.ts's next buildRequest() won't send it — only POST /:id/push
 *     (promoteQueuedPush, 'draft' -> 'pending') puts it on the wire.
 *   - Created here, not yet in QB (txn_id IS NULL, migration 058) — nothing
 *     to push_queue against yet (it's keyed by txn_id), so a PUT writes the
 *     row directly, and POST /:id/push instead sets pending_add=true, which
 *     tells estimate.ts's next buildRequest() to send an EstimateAddRq. Once
 *     that succeeds, the row gets a real txn_id and joins the first lifecycle.
 * Either way: editable in TBWC, but nothing reaches QuickBooks until the
 * explicit "Push to QuickBooks" action — never automatically on save.
 *
 * Visibility mirrors orders: admins see every estimate; everyone else sees
 * their own plus every user they manage's (public.user_manager, flat one
 * level — see middleware.ts's visibleRepListIds), read-only — no
 * estimate:write grant for non-admins (migration 056).
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission, visibleRepListIds } from '../middleware';
import { redactRow, redactRows } from '@meterit/framework-backend/api/base/permissions';
import { findAll, findById, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { estimateSchema } from './estimateSchema';
import { queueFieldPush, promoteQueuedPush } from '../qbwc/pushQueue';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'qb_estimate';
const PK = 'qb_estimate_id';
const [DEFAULT_SORT_FIELD, DEFAULT_SORT_ORDER] = estimateSchema.schema.defaultSortBy.split(/\s+/);
const SEARCH = ['customer_name', 'ref_number'];
const LIKE_FIELDS = likeFieldsFromSchema(estimateSchema);

// Fields a PUT on an already-synced estimate may stage as a push-queue draft.
// Maps to the object_type estimate.ts's qbwc_push_queue rows use — see
// FIELD_TO_QB_TAG there. (A still-local draft, txn_id IS NULL, writes these
// same field names directly instead — see the PUT handler.)
const PUSHABLE: Record<string, string> = {
  memo: 'Estimate',
  lines: 'Estimate',
};

// TBWC-owned, never touched by the sync or a push — written directly
// regardless of txn_id state (migration 059). Unlike memo/lines, QuickBooks
// has no concept of this at all, so there's nothing to stage or push.
const WRITABLE = new Set(['status']);

// One correlated-subquery column per pushable field, COALESCEd over the real
// column so GET always returns the effective value — a draft/pending/failed
// edit while it's staged or in flight, the real synced value once nothing's
// queued. For a still-local draft (txn_id IS NULL) this subquery can never
// match a row (nothing is queued against a null txn_id), so it always falls
// back to the real column — exactly right, since a local draft's edits live
// there directly.
const PENDING_FIELD_SELECT = Object.keys(PUSHABLE)
  .map((f) =>
    `COALESCE((SELECT q.new_value FROM public.qbwc_push_queue q WHERE q.object_type = 'Estimate' ` +
    `AND q.txn_id = "${TABLE}".txn_id AND q.field_name = '${f}' AND q.status IN ('draft', 'pending', 'failed'))` +
    `${f === 'lines' ? '::jsonb' : ''}, "${TABLE}".${f}) AS ${f}`
  )
  .join(', ');

// Where this record actually stands with QuickBooks — surfaced as one of
// three states so the form (and list) can say something more honest than a
// single true/false "has changes":
//   'draft'   — edited (or newly created) but never asked to push. The
//               button is enabled; nothing has been queued yet.
//   'pending' — the push button WAS pressed: either pending_add (a still-local
//               draft queued for an EstimateAddRq) or a qbwc_push_queue row
//               promoted to 'pending'/'failed' (an EstimateModRq) — queued for
//               the next QBWC session, not yet confirmed landed. The button is
//               disabled; pressing it again would be a no-op.
//   'synced'  — txn_id is set and nothing is queued: the last-known state
//               actually matches QuickBooks.
// Distinguishing 'pending' from 'synced' is the whole point — without it,
// clicking Push looked identical to nothing happening (promoteQueuedPush
// clears the 'draft' row immediately, before a QBWC session has even run).
const PUSH_STATE_SELECT = `(CASE
  WHEN "${TABLE}".txn_id IS NULL AND "${TABLE}".pending_add THEN 'pending'
  WHEN "${TABLE}".txn_id IS NULL THEN 'draft'
  WHEN EXISTS (SELECT 1 FROM public.qbwc_push_queue q WHERE q.object_type = 'Estimate'
    AND q.txn_id = "${TABLE}".txn_id AND q.status IN ('pending', 'failed')) THEN 'pending'
  WHEN EXISTS (SELECT 1 FROM public.qbwc_push_queue q WHERE q.object_type = 'Estimate'
    AND q.txn_id = "${TABLE}".txn_id AND q.status = 'draft') THEN 'draft'
  ELSE 'synced'
END) AS push_state`;

const SELECT_WITH_PENDING = `"${TABLE}".*, ${PENDING_FIELD_SELECT}, ${PUSH_STATE_SELECT}`;

/** True when this caller's estimate:read grant is limited to their own rows. */
function ownOnly(c: any): boolean {
  return c.get('permissions')?.scopeOf('estimate:read') === 'own';
}

function sumLines(lines: any): number | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const sum = lines.reduce((s: number, l: any) => s + (Number(l?.amount) || 0), 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Confirms `listId` is a real, non-deleted QuickBooks customer and returns
 * its authoritative name — server-side backstop for the picker on the
 * create/edit form (ReferenceSearchField only ever commits a value the user
 * picked from a live /customers search, but nothing stopped a stale or
 * hand-crafted request from naming a customer that doesn't exist, or one QB
 * has since deleted). Returns null if there's no such customer; callers turn
 * that into a 400 rather than saving a row an EstimateAdd would only get
 * rejected for later, with a much less useful QB error message.
 */
async function resolveCustomer(env: Env, listId: string): Promise<{ full_name: string | null } | null> {
  const r = await execQuery(
    env,
    `SELECT full_name FROM public.qb_customer WHERE list_id = $1 AND qb_deleted_at IS NULL`,
    [listId],
    'estimates.resolveCustomer'
  );
  return r.rows[0] ?? null;
}

app.get('/', requirePermission('estimate:read'), async (c) => {
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
    selectFields: SELECT_WITH_PENDING,
  });
  const items = redactRows(c.get('permissions'), 'estimate:read', result.rows);
  return c.json({ success: true, data: { items, total: result.pagination.total } });
});

app.get('/:id', requirePermission('estimate:read'), async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'), undefined, SELECT_WITH_PENDING);
  if (!row) return c.json({ success: false, message: 'Estimate not found' }, 404);
  if (ownOnly(c) && (!row.sales_rep_list_id || !visibleRepListIds(user).includes(row.sales_rep_list_id))) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }
  return c.json({ success: true, data: redactRow(c.get('permissions'), 'estimate:read', row) });
});

// Creates a still-local draft — txn_id stays NULL until POST /:id/push queues
// an EstimateAddRq and QB's response assigns one (see estimate.ts). Nothing
// here reaches QuickBooks by itself.
app.post('/', requirePermission('estimate:write'), async (c) => {
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
  const r = await execQuery(
    c.env,
    `INSERT INTO public.qb_estimate
       (customer_list_id, customer_name, txn_date, total, lines, memo, sales_rep_list_id, sales_rep, status, pending_add)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,COALESCE($9, 'quote'),false)
     RETURNING *`,
    [
      body.customer_list_id,
      customer.full_name,
      body.txn_date ?? null,
      sumLines(lines),
      JSON.stringify(lines),
      body.memo ?? null,
      body.sales_rep_list_id ?? user.sales_rep_list_id ?? null,
      body.sales_rep ?? user.sales_rep_name ?? null,
      body.status ?? null,
    ],
    'estimates.create'
  );
  return c.json({ success: true, data: redactRow(c.get('permissions'), 'estimate:read', r.rows[0]) }, 201);
});

app.put('/:id', requirePermission('estimate:write'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Estimate not found' }, 404);
  // No role grants own-scoped estimate:write today (migration 056), but the
  // scope is editable per role, so honour it here rather than assuming write
  // implies every row — same defensive check as orders.ts's PUT.
  if (c.get('permissions').scopeOf('estimate:write') === 'own') {
    const user = c.get('user');
    if (!existing.sales_rep_list_id || !visibleRepListIds(user).includes(existing.sales_rep_list_id)) {
      return c.json({ success: false, message: 'Not found' }, 404);
    }
  }

  const body = await c.req.json();
  let wroteSomething = false;

  // TBWC-owned, direct write regardless of sync state.
  const directCols: Record<string, any> = {};
  for (const k of WRITABLE) {
    if (k in body) directCols[k] = body[k];
  }

  // Still-local draft (never pushed to QB) — customer/date/memo/lines have
  // nothing to stage against yet either (qbwc_push_queue is keyed by
  // txn_id), so they're written directly too; customer/date are only ever
  // editable at this stage (createOnly in estimateSchema.ts).
  if (existing.txn_id == null) {
    if ('customer_list_id' in body) {
      const customer = await resolveCustomer(c.env, body.customer_list_id);
      if (!customer) {
        return c.json({ success: false, message: 'Unknown customer — pick one from the search results' }, 400);
      }
      directCols.customer_list_id = body.customer_list_id;
      directCols.customer_name = customer.full_name;
    }
    if ('txn_date' in body) directCols.txn_date = body.txn_date;
    if ('memo' in body) directCols.memo = body.memo;
    if ('lines' in body) {
      directCols.lines = JSON.stringify(Array.isArray(body.lines) ? body.lines : []);
      directCols.total = sumLines(body.lines);
    }
  }

  const keys = Object.keys(directCols);
  if (keys.length > 0) {
    const assignments = keys.map((k, i) => (k === 'lines' ? `${k} = $${i + 1}::jsonb` : `${k} = $${i + 1}`));
    const values = keys.map((k) => directCols[k]);
    values.push(id);
    await execQuery(
      c.env,
      `UPDATE public.${TABLE} SET ${assignments.join(', ')} WHERE ${PK} = $${values.length}`,
      values,
      'estimates.updateDirect'
    );
    wroteSomething = true;
  }

  // Already-synced record's memo/lines — staged, not written (see header
  // comment). Only reachable once txn_id is set; the local-draft branch
  // above already handled these same field names directly.
  if (existing.txn_id != null) {
    const drafts: [string, string | null][] = [];
    if ('memo' in body) drafts.push(['memo', body.memo == null ? null : String(body.memo)]);
    if ('lines' in body) drafts.push(['lines', body.lines == null ? null : JSON.stringify(body.lines)]);
    for (const [field, value] of drafts) {
      await queueFieldPush(c.env, PUSHABLE[field], existing.txn_id, field, value, 'draft');
      wroteSomething = true;
    }
  }

  if (!wroteSomething) {
    return c.json({ success: false, message: 'No editable fields in request' }, 400);
  }

  const row = await findById(c.env, TABLE, PK, id, undefined, SELECT_WITH_PENDING);
  return c.json({ success: true, data: row });
});

// Pushes this record to QuickBooks — an EstimateAddRq for a still-local draft
// (txn_id IS NULL), or promotes a synced record's staged edits ('draft' ->
// 'pending', an EstimateModRq) otherwise. No-op (400) if there's nothing to
// push, so a stray click can't be mistaken for a successful one.
app.post('/:id/push', requirePermission('estimate:write'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Estimate not found' }, 404);
  if (c.get('permissions').scopeOf('estimate:write') === 'own') {
    const user = c.get('user');
    if (!existing.sales_rep_list_id || !visibleRepListIds(user).includes(existing.sales_rep_list_id)) {
      return c.json({ success: false, message: 'Not found' }, 404);
    }
  }

  if (existing.txn_id == null) {
    if (existing.pending_add) {
      return c.json({ success: false, message: 'Already queued to create in QuickBooks' }, 400);
    }
    if (!existing.customer_list_id || !Array.isArray(existing.lines) || existing.lines.length === 0) {
      return c.json({ success: false, message: 'A customer and at least one line item are required before pushing' }, 400);
    }
    await execQuery(c.env, `UPDATE public.${TABLE} SET pending_add = true WHERE ${PK} = $1`, [id], 'estimates.queueAdd');
    const row = await findById(c.env, TABLE, PK, id, undefined, SELECT_WITH_PENDING);
    return c.json({ success: true, data: row, message: 'Queued to create in QuickBooks' });
  }

  const promoted = await promoteQueuedPush(c.env, 'Estimate', existing.txn_id, Object.keys(PUSHABLE));
  if (promoted.length === 0) {
    return c.json({ success: false, message: 'Nothing to push — no unsaved changes for this estimate' }, 400);
  }
  const row = await findById(c.env, TABLE, PK, id, undefined, SELECT_WITH_PENDING);
  return c.json({ success: true, data: row, message: `Queued for QuickBooks: ${promoted.join(', ')}` });
});

// A still-local draft (never reached QB) can be discarded outright; once
// synced, QuickBooks is the source of truth and deletion happens there.
app.delete('/:id', requirePermission('estimate:write'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Estimate not found' }, 404);
  if (existing.txn_id != null) {
    return c.json({ success: false, message: 'Synced estimates are managed by QuickBooks and cannot be deleted here.' }, 405);
  }
  const r = await execQuery(c.env, `DELETE FROM public.${TABLE} WHERE ${PK} = $1 RETURNING *`, [id], 'estimates.deleteDraft');
  return c.json({ success: true, data: r.rows[0] });
});

export default app;
