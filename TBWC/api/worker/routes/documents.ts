/**
 * Documents — per-record attachments for any TBWC module (orders, invoices,
 * inventory, quotes, support tickets today). Table public.document, PK
 * document_id; see migrations/026-documents.sql.
 *
 * Thin Hono wrapper over the framework module
 * (@meterit/framework-backend/api/base/documents) — this file owns only what is
 * TBWC-specific: auth middleware, which entity types are accepted, and the
 * response envelope.
 *
 * Bytes: the browser never touches the `record-docs` bucket with its own token.
 * The /storage/* routes below authorize in code (same checks as the metadata
 * routes) and hand back a signed URL — view, or upload-to — minted with the
 * service-role key. Bucket RLS is deny-all with no permission logic, so a new
 * custom role works without a migration (storageAdmin.ts).
 *
 * Access is per module's Documents grid (migration 100): a row with
 * entity_type 'order' needs orderGridDocument:read/create/write/delete, a
 * quote's needs quoteGridDocument:*, etc. (permissions.ts DOCUMENT_GRID_KEYS).
 * An own-scoped quote grant only reaches the caller's (and managed users')
 * quotes. The managing-rep and own-support-ticket carve-outs below still
 * apply on top for callers without the grid grant.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, permissionsFor, visibleRepListIds } from '../middleware';
import { DOCUMENT_GRID_KEYS } from '../permissions';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
  DocumentValidationError,
  DOC_TYPES,
  DEFAULT_DOC_TYPE,
} from '@meterit/framework-backend/api/base/documents';
import { allowedOptions } from '@meterit/framework-backend/api/base/permissions';
import { indexDocumentContent } from '@meterit/framework-backend/api/base/aiSearch';
import { emailStoredFile, FileEmailError } from '../fileEmail';
import { removeObjects, signObjectUrl, signUploadUrl, statObject, StorageAdminError } from '../storageAdmin';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

// Modules allowed to own documents. A new module adds its key here (and a
// Documents tab in its schema) — no migration needed.
const ENTITY_TYPES = Object.keys(DOCUMENT_GRID_KEYS) as (keyof typeof DOCUMENT_GRID_KEYS)[];

type GridAction = 'read' | 'create' | 'write' | 'delete';
/** `<entity>GridDocument:<action>` for a document row's entity_type. */
const gridPerm = (entityType: string, action: GridAction) =>
  `${DOCUMENT_GRID_KEYS[entityType as keyof typeof DOCUMENT_GRID_KEYS]}:${action}`;

function isEntityType(v: unknown): v is (typeof ENTITY_TYPES)[number] {
  return typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);
}

/**
 * The document types this caller's role deals in for one module — the role's
 * own setting, from Settings > Roles > <Module> > Documents > Type (stored as
 * `doc_type:<value>` view bits on the grid's read grant; see allowedOptions()
 * and documentGridSchema.ts's perOptionAccess). This used to be one hardcoded
 * list of four customer-facing types applied to orders only, which meant a new
 * role could not be given a different set without editing this file.
 *
 * Enforced here, not just filtered in the UI, since the UI alone can't stop a
 * direct API call. Read off the READ grant even on the write paths: the
 * question "which types does this role deal in" has one answer per module, and
 * a write path can be reached by the managing-rep carve-out below, which holds
 * no write grant of its own. A caller with a write grant but no read grant at
 * all (a configuration that can't browse the grid anyway) is not narrowed.
 */
function allowedDocTypes(permissions: any, entityType: string): readonly string[] {
  const readPerm = gridPerm(entityType, 'read');
  if (!permissions.has(readPerm)) return DOC_TYPES;
  return allowedOptions(permissions, readPerm, 'doc_type', DOC_TYPES);
}

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

/** True unless the caller's quoteGridDocument:<action> grant is scoped to
 *  'own' and `entityId`'s quote isn't one of the caller's visible reps' —
 *  own-scoped callers may only reach documents on their own quotes, the same
 *  way orders.ts's ownOnly scoping gates its own table. */
async function quoteOwnedByCaller(c: any, entityId: string, action: GridAction): Promise<boolean> {
  if (c.get('permissions')?.scopeOf(gridPerm('quote', action)) !== 'own') return true;
  const { rows } = await execQuery(
    c.env,
    `SELECT 1 FROM public.quote WHERE quote_id::text = $1 AND sales_rep_list_id = ANY($2::text[])`,
    [entityId, visibleRepListIds(c.get('user'))],
    'documents.quoteOwnedByCaller'
  );
  return rows.length > 0;
}

async function ensurePermissions(c: any) {
  let permissions = c.get('permissions');
  if (!permissions) {
    permissions = await permissionsFor(c.env, c.get('user'));
    c.set('permissions', permissions);
  }
  return permissions;
}

/**
 * Write access for one mutation, parking the resolved PermissionSet on the
 * context (same side effect requirePermission's own guard has) so
 * canAccessQuoteDocs above keeps working regardless of which branch below
 * grants access.
 *
 * A plain rep has no orderGridDocument grant (migrations/042-role-admin-
 * grants.sql) — but a "managing rep" (manages >=1 other user via the Users
 * form's Manages tab / public.user_manager, surfaced here as
 * managed_sales_rep_list_ids — see middleware.ts's loadProfile) may still
 * add/edit documents on THEIR MANAGED REPS' orders specifically (checked
 * against the actual order's sales_rep_list_id by managesOrderRep below —
 * matching orders.ts's ownOnly scoping precisely, not "manages someone,
 * somewhere" against every order company-wide). Scoped to entityType ===
 * 'order' only — it says nothing about invoice/inventory/quote documents,
 * which stay gated by document:write.
 *
 * restrictedOrderDocs says whether THIS caller's order-document access is the
 * limited kind — true exactly when they got in via the managing-rep carve-out
 * rather than an actual grant. It governs the upload SIZE cap
 * (REP_ORDER_MAX_FILE_SIZE below) only; which document TYPES a caller may file
 * is the role's own setting now (see allowedDocTypes). Driven by the grant
 * itself, not is_admin: an employee holds the write grant same as admin, so
 * either one is unrestricted.
 */
/** True when `entityId` is an order whose sales_rep_list_id is one of the
 *  reps THIS caller manages (public.user_manager) — not just "manages some
 *  rep, somewhere", which would wrongly grant document access to every
 *  order company-wide the moment someone manages a single rep. */
async function managesOrderRep(c: any, entityId: string): Promise<boolean> {
  const managed: string[] = c.get('user')?.managed_sales_rep_list_ids ?? [];
  if (managed.length === 0) return false;
  const { rows } = await execQuery(
    c.env,
    `SELECT 1 FROM public.qb_sales_order WHERE qb_sales_order_id::text = $1 AND sales_rep_list_id = ANY($2::text[])`,
    [entityId, managed],
    'documents.managesOrderRep'
  );
  return rows.length > 0;
}

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

async function resolveWriteAccess(
  c: any, entityType: string, entityId: string | undefined, action: Exclude<GridAction, 'read'>
): Promise<{ allowed: boolean; restrictedOrderDocs: boolean }> {
  if (!isEntityType(entityType)) return { allowed: false, restrictedOrderDocs: false };
  const permissions = await ensurePermissions(c);
  // "Full" document access for this module = the grid grant for this action.
  const hasDocumentWrite = !!permissions.has(gridPerm(entityType, action));
  if (entityType === 'quote' && hasDocumentWrite && entityId && !(await quoteOwnedByCaller(c, entityId, action))) {
    return { allowed: false, restrictedOrderDocs: false };
  }
  const isManagingRepOrder = entityType === 'order' && !!entityId && !hasDocumentWrite && (await managesOrderRep(c, entityId));
  // A rep/customer has no supportGridDocument:create grant, but
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

const RECORD_DOCS_BUCKET = 'record-docs';
// Share links go out by email, so the longest view URL lives a week.
const MAX_VIEW_URL_TTL = 60 * 60 * 24 * 7;
const DEFAULT_VIEW_URL_TTL = 60;

/**
 * Read check for one document row: the grid's read grant, own-scoped quote
 * ownership, and the rep-visible order doc types for anyone without the
 * order grid's write grant. Shared by email and view-url so "may I see this
 * file" has exactly one answer.
 */
async function canReadDocument(c: any, row: { entity_type: string; entity_id: string; doc_type: string }): Promise<boolean> {
  if (!isEntityType(row.entity_type)) return false;
  const permissions = await ensurePermissions(c);
  if (!permissions.has(gridPerm(row.entity_type, 'read'))) return false;
  if (row.entity_type === 'quote' && !(await quoteOwnedByCaller(c, row.entity_id, 'read'))) return false;
  if (!allowedDocTypes(permissions, row.entity_type).includes(row.doc_type)) return false;
  return true;
}

/**
 * "<entityType>/<entityId>/<file>" — the shape storagePathFor() builds. Returns
 * null for anything else (unknown module, traversal, missing segments), so a
 * caller can't aim a signed URL outside a record's own folder.
 */
function parseStoragePath(path: unknown): { entityType: string; entityId: string } | null {
  if (typeof path !== 'string' || path.length > 1024) return null;
  const parts = path.split('/');
  if (parts.length < 3 || parts.some((p) => !p || p === '.' || p === '..')) return null;
  if (!isEntityType(parts[0])) return null;
  return { entityType: parts[0], entityId: parts[1] };
}

/** True when the caller may put bytes into (or clean bytes out of) this record's folder. */
async function canWriteFolder(c: any, entityType: string, entityId: string): Promise<boolean> {
  for (const action of ['create', 'write'] as const) {
    if ((await resolveWriteAccess(c, entityType, entityId, action)).allowed) return true;
  }
  return false;
}

async function findDocumentByPath(c: any, path: string) {
  const { rows } = await execQuery(
    c.env,
    `SELECT document_id, entity_type, entity_id, doc_type
       FROM public.document WHERE storage_bucket = $1 AND storage_path = $2 LIMIT 1`,
    [RECORD_DOCS_BUCKET, path],
    'documents.findDocumentByPath'
  );
  return rows[0] ?? null;
}

function storageFail(c: any, e: unknown) {
  if (e instanceof StorageAdminError) return c.json({ success: false, message: e.message }, e.status);
  throw e;
}

/** Signed view URL for a file that belongs to a document row the caller may read. */
app.post('/storage/view-url', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!parseStoragePath(body.path)) return c.json({ success: false, message: 'Invalid path' }, 400);
  const row = await findDocumentByPath(c, body.path);
  // Not-yours and doesn't-exist answer the same, so the route can't probe paths.
  if (!row || !(await canReadDocument(c, row))) return c.json({ success: false, message: 'Document not found' }, 404);
  const requested = Number(body.expiresIn);
  const ttl = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_VIEW_URL_TTL) : DEFAULT_VIEW_URL_TTL;
  try {
    return c.json({ success: true, data: { url: await signObjectUrl(c.env, RECORD_DOCS_BUCKET, body.path, ttl) } });
  } catch (e) {
    return storageFail(c, e);
  }
});

/** Signed upload URL into a record's folder; the browser PUTs the bytes there itself. */
app.post('/storage/upload-url', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const target = parseStoragePath(body.path);
  if (!target) return c.json({ success: false, message: 'Invalid path' }, 400);
  if (!(await canWriteFolder(c, target.entityType, target.entityId))) return forbidden(c);
  try {
    return c.json({ success: true, data: { url: await signUploadUrl(c.env, RECORD_DOCS_BUCKET, body.path) } });
  } catch (e) {
    return storageFail(c, e);
  }
});

/**
 * Remove bytes no document row points at — the rollback after a failed
 * metadata write. A file that still has a row goes through DELETE /:id, which
 * applies the delete grant and drops the bytes itself.
 */
app.post('/storage/remove', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const target = parseStoragePath(body.path);
  if (!target) return c.json({ success: false, message: 'Invalid path' }, 400);
  if (!(await canWriteFolder(c, target.entityType, target.entityId))) return forbidden(c);
  if (await findDocumentByPath(c, body.path)) {
    return c.json({ success: false, message: 'File still belongs to a document — delete the document instead' }, 409);
  }
  try {
    await removeObjects(c.env, RECORD_DOCS_BUCKET, [body.path]);
    return c.json({ success: true, data: { removed: true } });
  } catch (e) {
    return storageFail(c, e);
  }
});

/** Do the bytes at `path` really exist, and how big? (Quote Import's post-upload check.) */
app.post('/storage/stat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const target = parseStoragePath(body.path);
  if (!target) return c.json({ success: false, message: 'Invalid path' }, 400);
  if (!(await canWriteFolder(c, target.entityType, target.entityId))) return forbidden(c);
  try {
    return c.json({ success: true, data: await statObject(c.env, RECORD_DOCS_BUCKET, body.path) });
  } catch (e) {
    return storageFail(c, e);
  }
});

app.get('/', async (c) => {
  const entityType = c.req.query('entity_type');
  const entityId = c.req.query('entity_id');
  if (!isEntityType(entityType)) return c.json({ success: false, message: 'Unknown entity_type' }, 400);
  if (!entityId) return c.json({ success: false, message: 'entity_id is required' }, 400);
  const permissions = await ensurePermissions(c);
  if (!permissions.has(gridPerm(entityType, 'read'))) return forbidden(c);
  if (entityType === 'quote' && !(await quoteOwnedByCaller(c, entityId, 'read'))) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }

  try {
    let rows = await listDocuments(execQuery, c.env, entityType, entityId);
    // The role's own type set for this module (see allowedDocTypes). Skipped
    // entirely when nothing is turned off, which is every role that has not
    // been narrowed.
    const types = allowedDocTypes(permissions, entityType);
    if (types.length !== DOC_TYPES.length) {
      rows = rows.filter((r) => types.includes(r.doc_type));
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
  const { allowed, restrictedOrderDocs } = await resolveWriteAccess(c, body.entityType, body.entityId, 'create');
  if (!allowed) return forbidden(c);
  // The type that will actually be stored: createDocument falls back to
  // DEFAULT_DOC_TYPE when the body names none, so that is what gets checked —
  // a role not granted the default has to pick a type it does hold.
  const createTypes = allowedDocTypes(await ensurePermissions(c), body.entityType);
  const createType = body.docType ?? DEFAULT_DOC_TYPE;
  if (!createTypes.includes(createType)) {
    return c.json({ success: false, message: `doc_type must be one of: ${createTypes.join(', ')}` }, 400);
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
    // Extracts text + indexes it for search_document_contents (aiChat.ts) /
    // the header search bar's "search file contents" — backgrounded so the
    // upload response doesn't wait on downloading the file back down and
    // parsing it. backfillDocumentIndex (Worker cron) catches anything that
    // fails here.
    c.executionCtx.waitUntil(
      indexDocumentContent(execQuery, c.env, row).catch((e) =>
        console.error('[documents] indexDocumentContent failed:', e instanceof Error ? e.message : e)
      )
    );
    return c.json({ success: true, data: row }, 201);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * Email one document as a real attachment. Read-level access, not write: sending
 * a file to someone is a read of it, and a rep who may see a packing slip may
 * send it to the customer. The Worker pulls the bytes and sends them, so nothing
 * lands on the sender's machine (see fileEmail.ts for why that matters).
 */
app.post('/:id/email', async (c) => {
  const existing = await getDocument(execQuery, c.env, c.req.param('id'));
  if (!existing) return c.json({ success: false, message: 'Document not found' }, 404);
  if (!isEntityType(existing.entity_type)) return c.json({ success: false, message: 'Document not found' }, 404);

  // Same rules as the list route: a caller who only sees the rep-visible
  // order doc types must not be able to email an internal one either.
  if (!(await ensurePermissions(c)).has(gridPerm(existing.entity_type, 'read'))) return forbidden(c);
  if (!(await canReadDocument(c, existing))) return c.json({ success: false, message: 'Document not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  try {
    const recipients = await emailStoredFile(
      c.env,
      {
        bucket: existing.storage_bucket || 'record-docs',
        path: existing.storage_path || '',
        fileName: existing.file_name,
        mimeType: existing.mime_type,
      },
      { to: body.to, subject: body.subject, message: body.message, replyTo: c.get('user')?.email }
    );
    return c.json({ success: true, data: { sent: true, recipients } });
  } catch (e) {
    if (e instanceof FileEmailError) return c.json({ success: false, message: e.message }, e.status);
    throw e;
  }
});

app.put('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    // Needed either way now (the write-access/quote gates below apply
    // regardless of which fields changed), so fetched unconditionally rather
    // than only when docType is set.
    const existing = await getDocument(execQuery, c.env, c.req.param('id'));
    const { allowed, restrictedOrderDocs } = await resolveWriteAccess(c, existing?.entity_type ?? '', existing?.entity_id, 'write');
    if (!allowed) return forbidden(c);
    if (body.docType !== undefined) {
      const types = allowedDocTypes(await ensurePermissions(c), existing?.entity_type ?? '');
      if (!types.includes(body.docType)) {
        return c.json({ success: false, message: `doc_type must be one of: ${types.join(', ')}` }, 400);
      }
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

// Deletes the row, then its bytes (service role — the browser has no bucket
// access of its own), and hands the row back.
app.delete('/:id', async (c) => {
  // Fetched first, before deleting, so the write-access/quote gates can
  // run on its entity_type — deleteDocument's returned row would be too late
  // to check.
  const existing = await getDocument(execQuery, c.env, c.req.param('id'));
  if (!existing) return c.json({ success: false, message: 'Document not found' }, 404);
  const { allowed } = await resolveWriteAccess(c, existing.entity_type, existing.entity_id, 'delete');
  if (!allowed) return forbidden(c);
  const row = await deleteDocument(execQuery, c.env, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Document not found' }, 404);
  // Metadata first, bytes second: an orphaned object is sweepable, an orphaned
  // row is a broken link in the grid — so a failed removal is logged, not surfaced.
  if (row.storage_path) {
    await removeObjects(c.env, row.storage_bucket || RECORD_DOCS_BUCKET, [row.storage_path]).catch((e) =>
      console.error('[documents] removing bytes failed:', e instanceof Error ? e.message : e)
    );
  }
  return c.json({ success: true, data: row });
});

export default app;
