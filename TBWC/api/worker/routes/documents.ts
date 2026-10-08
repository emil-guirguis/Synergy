/**
 * Documents — per-record attachments for any TBWC module (orders, invoices,
 * inventory, quotes, support tickets today). Table public.document, PK
 * document_id; see migrations/026-documents.sql.
 *
 * Thin Hono wrapper over the framework module
 * (@meterit/framework-backend/api/base/documents) — this file owns only what is
 * TBWC-specific: auth middleware, which entity types are accepted, and the
 * response envelope. File bytes never pass through here: the browser uploads
 * straight to the Supabase `record-docs` bucket and posts the metadata back.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, permissionsFor, requirePermission } from '../middleware';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
  DocumentValidationError,
} from '@meterit/framework-backend/api/base/documents';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

// Modules allowed to own documents. A new module adds its key here (and a
// Documents tab in its schema) — no migration needed.
const ENTITY_TYPES = ['order', 'quote', 'invoice', 'inventory', 'support_ticket'] as const;

function isEntityType(v: unknown): v is (typeof ENTITY_TYPES)[number] {
  return typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);
}

// A rep's order Documents tab shows only these. Enforced here, not just
// hidden in the UI, since the UI alone can't stop a direct API call. Mirrors
// REP_VISIBLE_DOC_TYPES in TBWC/frontend/src/features/orders/OrderForm.tsx.
const REP_VISIBLE_ORDER_DOC_TYPES = ['packing_slip', 'invoice', 'proof_of_delivery', 'load_schedule'] as const;
// Mirrors REP_MAX_FILE_SIZE in OrderForm.tsx — the client already blocks a
// bigger pick, this is the server-side backstop against a direct API call.
const REP_ORDER_MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Map the framework's input errors to 400s; anything else bubbles to the 500 handler. */
function fail(c: any, e: unknown) {
  if (e instanceof DocumentValidationError) {
    return c.json({ success: false, message: e.message }, 400);
  }
  throw e;
}

function forbidden(c: any) {
  return c.json({ success: false, message: 'Insufficient permissions' }, 403);
}

// document:read/document:write (checked above by requirePermission, or by
// resolveWriteAccess below for the mutating routes) is one flat grant
// covering every module's attachments — it says nothing about whether the
// caller can see or edit the *quote* a given row is attached to. An
// employee has document:write 'all' but no quote:write at all (migrations
// 040/042), so without this, they could add/delete documents on any quote
// despite having no access to quotes themselves. Gated by permission
// only, not by which quote — matching how every other permission check in
// this file works (document:read/write themselves carry no row-level scope
// either).
function canAccessQuoteDocs(c: any, action: 'quote:read' | 'quote:write'): boolean {
  return !!c.get('permissions')?.has(action);
}

/**
 * Write access for one mutation, parking the resolved PermissionSet on the
 * context (same side effect requirePermission's own guard has) so
 * canAccessQuoteDocs above keeps working regardless of which branch below
 * grants access.
 *
 * A plain rep has no document:write grant at all (migrations/042-role-admin-
 * grants.sql) — but a "managing rep" (manages >=1 other user via the Users
 * form's Manages tab / public.user_manager, surfaced here as
 * managed_sales_rep_list_ids — see middleware.ts's loadProfile) may still
 * add/edit their own orders' documents, matching the elevated access that
 * relation already grants them over those users' orders (orders.ts's ownOnly
 * scoping). Scoped to entityType === 'order' only — it says nothing about
 * invoice/inventory/quote documents, which stay gated by document:write.
 *
 * restrictedOrderDocs says whether THIS caller's order-document access is the
 * limited kind (REP_VISIBLE_ORDER_DOC_TYPES/REP_ORDER_MAX_FILE_SIZE below) —
 * true exactly when they got in via the managing-rep carve-out rather than an
 * actual document:write grant. Driven by the grant itself, not is_admin: an
 * employee holds document:write 'all' (migration 040) same as admin, so
 * either one is unrestricted; is_admin would wrongly restrict the employee.
 */
/** True when `entityId` is a support_ticket row the caller themselves filed. */
async function ownsSupportTicket(c: any, entityId: string): Promise<boolean> {
  const userId = c.get('user')?.id;
  if (!userId) return false;
  const { rows } = await execQuery(
    c.env,
    `SELECT 1 FROM public.support_ticket WHERE support_ticket_id = $1 AND users_id = $2`,
    [entityId, userId],
    'documents.ownsSupportTicket'
  );
  return rows.length > 0;
}

async function resolveWriteAccess(c: any, entityType: string, entityId?: string): Promise<{ allowed: boolean; restrictedOrderDocs: boolean }> {
  const user = c.get('user');
  let permissions = c.get('permissions');
  if (!permissions) {
    permissions = await permissionsFor(c.env, user);
    c.set('permissions', permissions);
  }
  const hasDocumentWrite = !!permissions.has('document:write');
  const isManagingRepOrder = entityType === 'order' && (user?.managed_sales_rep_list_ids?.length ?? 0) > 0;
  // A rep/customer has no document:write grant at all (see comment above), but
  // they should still be able to attach their own files to a ticket they
  // filed (e.g. a photo for an RMA) — scoped to exactly that ticket via
  // support_ticket.users_id, unlike isManagingRepOrder's broader carve-out.
  const isOwnSupportTicket =
    entityType === 'support_ticket' && !!entityId && !hasDocumentWrite && (await ownsSupportTicket(c, entityId));
  return {
    allowed: hasDocumentWrite || isManagingRepOrder || isOwnSupportTicket,
    restrictedOrderDocs: entityType === 'order' && !hasDocumentWrite,
  };
}

app.get('/', requirePermission('document:read'), async (c) => {
  const entityType = c.req.query('entity_type');
  const entityId = c.req.query('entity_id');
  if (!isEntityType(entityType)) return c.json({ success: false, message: 'Unknown entity_type' }, 400);
  if (!entityId) return c.json({ success: false, message: 'entity_id is required' }, 400);
  if (entityType === 'quote' && !canAccessQuoteDocs(c, 'quote:read')) return forbidden(c);

  try {
    let rows = await listDocuments(execQuery, c.env, entityType, entityId);
    // Same restriction as the write side below, keyed off the same grant:
    // document:write covers admin and employee alike, so only someone
    // lacking it (plain rep, or a managing rep who only got order-doc access
    // via that carve-out) has the internal doc types filtered out of reads.
    if (entityType === 'order' && !c.get('permissions')?.has('document:write')) {
      rows = rows.filter((r) => (REP_VISIBLE_ORDER_DOC_TYPES as readonly string[]).includes(r.doc_type));
    }
    return c.json({ success: true, data: rows });
  } catch (e) {
    return fail(c, e);
  }
});

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isEntityType(body.entityType)) return c.json({ success: false, message: 'Unknown entityType' }, 400);
  if (body.storageBucket !== 'record-docs') {
    return c.json({ success: false, message: 'Unknown storage bucket' }, 400);
  }
  const { allowed, restrictedOrderDocs } = await resolveWriteAccess(c, body.entityType, body.entityId);
  if (!allowed) return forbidden(c);
  if (body.entityType === 'quote' && !canAccessQuoteDocs(c, 'quote:write')) return forbidden(c);
  if (restrictedOrderDocs && !(REP_VISIBLE_ORDER_DOC_TYPES as readonly string[]).includes(body.docType)) {
    return c.json({ success: false, message: `doc_type must be one of: ${REP_VISIBLE_ORDER_DOC_TYPES.join(', ')}` }, 400);
  }

  try {
    const row = await createDocument(
      execQuery,
      c.env,
      {
        ...body,
        // Ownership comes from the verified token, never the request body.
        createdBy: c.get('userId'),
      },
      restrictedOrderDocs ? { maxFileSize: REP_ORDER_MAX_FILE_SIZE } : undefined
    );
    return c.json({ success: true, data: row }, 201);
  } catch (e) {
    return fail(c, e);
  }
});

app.put('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    // Needed either way now (the write-access/quote gates below apply
    // regardless of which fields changed), so fetched unconditionally rather
    // than only when docType is set.
    const existing = await getDocument(execQuery, c.env, c.req.param('id'));
    const { allowed, restrictedOrderDocs } = await resolveWriteAccess(c, existing?.entity_type ?? '', existing?.entity_id);
    if (!allowed) return forbidden(c);
    if (existing?.entity_type === 'quote' && !canAccessQuoteDocs(c, 'quote:write')) return forbidden(c);
    if (
      body.docType !== undefined &&
      restrictedOrderDocs &&
      !(REP_VISIBLE_ORDER_DOC_TYPES as readonly string[]).includes(body.docType)
    ) {
      return c.json({ success: false, message: `doc_type must be one of: ${REP_VISIBLE_ORDER_DOC_TYPES.join(', ')}` }, 400);
    }
    const row = await updateDocument(execQuery, c.env, c.req.param('id'), {
      description: body.description,
      docType: body.docType,
    });
    if (!row) return c.json({ success: false, message: 'Document not found' }, 404);
    return c.json({ success: true, data: row });
  } catch (e) {
    return fail(c, e);
  }
});

// Deletes the row and hands it back; the client then drops the object from the
// bucket with its own token (see framework DocumentsGrid.confirmDelete).
app.delete('/:id', async (c) => {
  // Fetched first, before deleting, so the write-access/quote gates can
  // run on its entity_type — deleteDocument's returned row would be too late
  // to check.
  const existing = await getDocument(execQuery, c.env, c.req.param('id'));
  if (!existing) return c.json({ success: false, message: 'Document not found' }, 404);
  const { allowed } = await resolveWriteAccess(c, existing.entity_type, existing.entity_id);
  if (!allowed) return forbidden(c);
  if (existing.entity_type === 'quote' && !canAccessQuoteDocs(c, 'quote:write')) return forbidden(c);
  const row = await deleteDocument(execQuery, c.env, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Document not found' }, 404);
  return c.json({ success: true, data: row });
});

export default app;
