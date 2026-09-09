/**
 * Documents — per-record attachments for any TBWC module (orders, invoices,
 * inventory today). Table public.document, PK document_id; see
 * migrations/026-documents.sql.
 *
 * Thin Hono wrapper over the framework module
 * (@meterit/framework-backend/api/base/documents) — this file owns only what is
 * TBWC-specific: auth middleware, which entity types are accepted, and the
 * response envelope. File bytes never pass through here: the browser uploads
 * straight to the Supabase `record-docs` bucket and posts the metadata back.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken } from '../middleware';
import {
  createDocument,
  deleteDocument,
  listDocuments,
  updateDocument,
  DocumentValidationError,
} from '@meterit/framework-backend/api/base/documents';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

// Modules allowed to own documents. A new module adds its key here (and a
// Documents tab in its schema) — no migration needed.
const ENTITY_TYPES = ['order', 'invoice', 'inventory'] as const;

function isEntityType(v: unknown): v is (typeof ENTITY_TYPES)[number] {
  return typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);
}

/** Map the framework's input errors to 400s; anything else bubbles to the 500 handler. */
function fail(c: any, e: unknown) {
  if (e instanceof DocumentValidationError) {
    return c.json({ success: false, message: e.message }, 400);
  }
  throw e;
}

app.get('/', async (c) => {
  const entityType = c.req.query('entity_type');
  const entityId = c.req.query('entity_id');
  if (!isEntityType(entityType)) return c.json({ success: false, message: 'Unknown entity_type' }, 400);
  if (!entityId) return c.json({ success: false, message: 'entity_id is required' }, 400);

  try {
    const rows = await listDocuments(execQuery, c.env, entityType, entityId);
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

  try {
    const row = await createDocument(execQuery, c.env, {
      ...body,
      // Ownership comes from the verified token, never the request body.
      createdBy: c.get('userId'),
    });
    return c.json({ success: true, data: row }, 201);
  } catch (e) {
    return fail(c, e);
  }
});

app.put('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
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
  const row = await deleteDocument(execQuery, c.env, c.req.param('id'));
  if (!row) return c.json({ success: false, message: 'Document not found' }, 404);
  return c.json({ success: true, data: row });
});

export default app;
