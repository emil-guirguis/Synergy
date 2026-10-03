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
import { Env } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { findAll, findById, create, update, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { supportTicketSchema } from '@meterit/framework-backend/api/base/supportTicketSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'support_ticket';
const PK = 'support_ticket_id';
const LIKE_FIELDS = likeFieldsFromSchema(supportTicketSchema);

function ownOnly(c: any): boolean {
  return c.get('permissions')?.scopeOf('support:read') === 'own';
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
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

app.get('/:id', requirePermission('support:read'), async (c) => {
  const user = c.get('user');
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row || (ownOnly(c) && row.users_id !== user.id)) {
    return c.json({ success: false, message: 'Ticket not found' }, 404);
  }
  return c.json({ success: true, data: row });
});

// Any caller who can see Support may file a ticket — same as support:read.
app.post('/', requirePermission('support:read'), async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { title, description, type, priority } = body;
  if (!title?.trim()) return c.json({ success: false, message: 'Title is required' }, 400);
  const row = await create(c.env, TABLE, {
    users_id: user.id,
    title: title.trim(),
    description: description ?? null,
    type: type ?? 'general',
    priority: priority ?? 'medium',
    status: 'open',
  });
  return c.json({ success: true, data: row }, 201);
});

app.put('/:id', requirePermission('support:write'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing) return c.json({ success: false, message: 'Ticket not found' }, 404);
  const body = await c.req.json();
  const { title, description, status, priority, type, assigned_to_users_id } = body;
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
    resolved_at,
  });
  return c.json({ success: true, data: row });
});

export default app;
