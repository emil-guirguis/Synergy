/**
 * Support ticket API routes — TBWC's half of the shared Support module
 * (framework/backend/db/support_ticket.sql, framework/frontend/support/*).
 * MeterItPro's companion "Devices" sub-feature has no TBWC equivalent (no
 * device catalog here) and isn't part of this module.
 *
 * TBWC has no tenant concept, so visibility is per-user rather than
 * per-client-org: support:read's scope is 'own' for a regular caller (their
 * own filed tickets only) or 'all' for admin — same own/all split
 * order:read uses, see orders.ts. support:write gates the admin-only edits
 * (status/priority/type/assignee).
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { findAll, findById, create, update, remove, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { supportTicketSchema } from '@meterit/framework-backend/api/base/supportTicketSchema';
import { notifyTicketCreated, notifyTicketStatusChanged, notifyTicketAssigned } from '../supportNotify';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'support_ticket';
const PK = 'support_ticket_id';
const LIKE_FIELDS = likeFieldsFromSchema(supportTicketSchema);

// Joined with creator/assignee names so the shared TicketDetailPage (framework/
// frontend/support) has something to show in its "Created by"/"Assigned to"
// metadata without a second round trip per ticket.
const SELECT_WITH_USERS = `
  "${TABLE}".*,
  TRIM(CONCAT(creator.first_name, ' ', creator.last_name)) AS created_by_name,
  creator.email AS created_by_email,
  TRIM(CONCAT(assignee.first_name, ' ', assignee.last_name)) AS assigned_to_name,
  assignee.email AS assigned_to_email
`;
const JOIN_USERS = `
  LEFT JOIN public.users creator  ON creator.id  = "${TABLE}".users_id
  LEFT JOIN public.users assignee ON assignee.id = "${TABLE}".assigned_to_users_id
`;

function ownOnly(c: any): boolean {
  return c.get('permissions')?.scopeOf('support:read') === 'own';
}

function canWrite(c: any): boolean {
  return !!c.get('permissions')?.scopeOf('support:write');
}

app.get('/', requirePermission('support:read'), async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS });
  const where = ownOnly(c) ? { ...fieldWhere, users_id: user.id } : fieldWhere;
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    orderBy: q.sortBy ? undefined : `"${TABLE}".created_at DESC`,
    where,
    whereLike,
    joins: JOIN_USERS,
    selectFields: SELECT_WITH_USERS,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

// Registered before GET /:id so Hono doesn't route "analytics" there as an id.
app.get('/analytics', requirePermission('support:write'), async (c) => {
  const [totals, byStatus] = await Promise.all([
    execQuery(
      c.env,
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')  AS last_7d,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS last_30d,
         AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0)
           FILTER (WHERE resolved_at IS NOT NULL) AS avg_resolution_hours,
         AVG(csat_rating) FILTER (WHERE csat_rating IS NOT NULL) AS avg_csat,
         COUNT(csat_rating) AS csat_count
       FROM public.support_ticket`,
      [],
      'support.analytics.totals'
    ),
    execQuery(
      c.env,
      `SELECT status, COUNT(*) AS count FROM public.support_ticket GROUP BY status`,
      [],
      'support.analytics.byStatus'
    ),
  ]);
  const t = totals.rows[0];
  return c.json({
    success: true,
    data: {
      total: Number(t.total),
      last_7_days: Number(t.last_7d),
      last_30_days: Number(t.last_30d),
      avg_resolution_hours: t.avg_resolution_hours != null ? Number(t.avg_resolution_hours) : null,
      avg_csat: t.avg_csat != null ? Number(t.avg_csat) : null,
      csat_count: Number(t.csat_count),
      by_status: Object.fromEntries(byStatus.rows.map((r) => [r.status, Number(r.count)])),
    },
  });
});

app.get('/:id', requirePermission('support:read'), async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'), undefined, SELECT_WITH_USERS, JOIN_USERS);
  if (!row || (ownOnly(c) && row.users_id !== user.id)) {
    return c.json({ success: false, message: 'Ticket not found' }, 404);
  }
  return c.json({ success: true, data: row });
});

// Any caller who can see Support may file a ticket — same as support:read.
app.post('/', requirePermission('support:read'), async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { title, description, type, priority, serial_number, status } = body;
  if (!title?.trim()) return c.json({ success: false, message: 'Title is required' }, 400);
  // Only an admin's own payload can set an initial status other than 'open'
  // (e.g. logging a ticket that's already resolved) — a regular filer's
  // status is ignored even if present in the body.
  const initialStatus = canWrite(c) && status ? status : 'open';
  const row = await create(c.env, TABLE, {
    users_id: user.id,
    title: title.trim(),
    description: description ?? null,
    type: type ?? 'general',
    priority: priority ?? 'medium',
    serial_number: serial_number?.trim() || null,
    status: initialStatus,
  });
  c.executionCtx.waitUntil(
    notifyTicketCreated(c.env, row, { email: user.email ?? null, first_name: user.first_name ?? null }).catch((e) =>
      console.error('[support] notifyTicketCreated failed:', e instanceof Error ? e.message : e)
    )
  );
  return c.json({ success: true, data: row }, 201);
});

app.put('/:id', requirePermission('support:write'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Ticket not found' }, 404);
  const body = await c.req.json();
  const { title, description, status, priority, type, assigned_to_users_id, serial_number } = body;
  if (!title?.trim()) return c.json({ success: false, message: 'Title is required' }, 400);
  const resolvedStatus = status ?? 'open';
  const resolved_at = ['resolved', 'closed'].includes(resolvedStatus)
    ? existing.resolved_at ?? new Date().toISOString()
    : null;
  const row = await update(c.env, TABLE, PK, id, {
    title: title.trim(),
    description: description ?? null,
    status: resolvedStatus,
    priority: priority ?? 'medium',
    type: type ?? 'general',
    assigned_to_users_id: assigned_to_users_id ?? null,
    serial_number: serial_number?.trim() || null,
    resolved_at,
  });
  const withUsers = await findById(c.env, TABLE, PK, id, undefined, SELECT_WITH_USERS, JOIN_USERS);
  const ticketForNotify = withUsers ?? row;

  if (resolvedStatus !== existing.status) {
    c.executionCtx.waitUntil(
      notifyTicketStatusChanged(
        c.env,
        ticketForNotify,
        { email: ticketForNotify.created_by_email ?? null, first_name: ticketForNotify.created_by_name?.split(' ')[0] ?? null },
        resolvedStatus
      ).catch((e) => console.error('[support] notifyTicketStatusChanged failed:', e instanceof Error ? e.message : e))
    );
  }
  const assigneeChanged = (assigned_to_users_id ?? null) !== (existing.assigned_to_users_id ?? null);
  if (assigneeChanged && assigned_to_users_id) {
    c.executionCtx.waitUntil(
      notifyTicketAssigned(
        c.env,
        ticketForNotify,
        { email: ticketForNotify.assigned_to_email ?? null, first_name: ticketForNotify.assigned_to_name?.split(' ')[0] ?? null }
      ).catch((e) => console.error('[support] notifyTicketAssigned failed:', e instanceof Error ? e.message : e))
    );
  }

  return c.json({ success: true, data: ticketForNotify });
});

// The filer rates their own resolved/closed ticket — not gated by
// support:write (that's the admin-edit permission), just by actually being
// the ticket's own filer. One rating per ticket: silently ignores a repeat
// call rather than erroring, since the "rate this" UI only shows once anyway.
app.post('/:id/csat', requirePermission('support:read'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing || existing.users_id !== user.id) {
    return c.json({ success: false, message: 'Ticket not found' }, 404);
  }
  if (!['resolved', 'closed'].includes(existing.status)) {
    return c.json({ success: false, message: 'Ticket is not resolved yet' }, 400);
  }
  const { rating } = await c.req.json().catch(() => ({}));
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    return c.json({ success: false, message: 'rating must be an integer 1-5' }, 400);
  }
  if (existing.csat_rating != null) {
    return c.json({ success: true, data: existing });
  }
  const row = await update(c.env, TABLE, PK, id, {
    csat_rating: n,
    csat_submitted_at: new Date().toISOString(),
  });
  return c.json({ success: true, data: row });
});

app.delete('/:id', requirePermission('support:write'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Ticket not found' }, 404);

  // document rows are keyed by (entity_type, entity_id) with no FK (see
  // framework/backend/db/document.sql) — deleting the ticket out from under
  // them would orphan both the metadata row and its storage object, so block
  // instead, same shape as crud.ts's checkDeleteRestrictions (can't reuse it
  // directly: it only filters by one FK column, not entity_type+entity_id).
  const docs = await execQuery(
    c.env,
    `SELECT COUNT(*)::int AS count FROM public.document WHERE entity_type = 'support_ticket' AND entity_id = $1`,
    [id],
    'support.delete.checkDocuments'
  );
  if (docs.rows[0]?.count > 0) {
    return c.json({ success: false, message: 'Remove this ticket\'s attached documents first.' }, 400);
  }

  const row = await remove(c.env, TABLE, PK, id);
  return c.json({ success: true, data: row });
});

export default app;
