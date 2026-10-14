import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable auth + a minimal PermissionSet stand-in (just .has(), which is
// all this route reads off it) — real resolution is framework-tested
// elsewhere (permissions.ts). No is_admin anywhere: documents.ts reads real
// grants only — each module's Documents grid permission (<module>GridDocument:*,
// migration 100), which covers admin and employee identically.
const ALL_GRID = ['order', 'quote', 'invoice', 'inventory', 'support'].flatMap((k) =>
  ['read', 'create', 'write', 'delete'].map((a) => `${k}GridDocument:${a}`)
);
let currentUser: any = { id: 'admin' };
let currentGrants: string[] = [];
let fakeGrants: string[] = [...ALL_GRID];
// Per-permission scope override — unset means 'all' for anything in fakeGrants.
let fakeScopes: Record<string, 'own' | 'all'> = {};

function fakePermSet() {
  return {
    has: (p: string) => fakeGrants.includes(p),
    scopeOf: (p: string) => (fakeGrants.includes(p) ? fakeScopes[p] ?? 'all' : null),
  };
}

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', currentUser);
    c.set('userId', currentUser.id);
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) => {
    if (!currentGrants.includes(permission)) {
      return c.json({ success: false, message: 'Insufficient permissions' }, 403);
    }
    c.set('permissions', fakePermSet());
    return next();
  },
  // documents.ts's mutating routes resolve write access themselves (so a
  // "managing rep" can bypass the document:write grant on order documents)
  // instead of going through the requirePermission middleware above — same
  // fake PermissionSet shape either way.
  permissionsFor: async () => fakePermSet(),
  visibleRepListIds: (user: any) => [user.sales_rep_list_id, ...(user.managed_sales_rep_list_ids ?? [])].filter(Boolean),
}));

const mockListDocuments = vi.fn();
const mockGetDocument = vi.fn();
const mockCreateDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockDeleteDocument = vi.fn();

vi.mock('@meterit/framework-backend/api/base/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meterit/framework-backend/api/base/documents')>();
  return {
    ...actual,
    listDocuments: (...a: any[]) => mockListDocuments(...a),
    getDocument: (...a: any[]) => mockGetDocument(...a),
    createDocument: (...a: any[]) => mockCreateDocument(...a),
    updateDocument: (...a: any[]) => mockUpdateDocument(...a),
    deleteDocument: (...a: any[]) => mockDeleteDocument(...a),
  };
});

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import documentsApp from './documents';

const ENV = {} as any;
// Real Workers give every request a live ExecutionContext; Hono's test
// request() leaves it undefined unless passed explicitly, so routes using
// c.executionCtx.waitUntil() (e.g. the indexDocumentContent kick-off below)
// need this stub or they throw "This context has no ExecutionContext".
const EXECUTION_CTX = { waitUntil: (p: Promise<any>) => { p.catch(() => {}); }, passThroughOnException: () => {}, props: {} };
const req = (path: string, init?: RequestInit) => documentsApp.request(path, init, ENV, EXECUTION_CTX);
const json = (method: string, body: any) => ({
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin' };
  currentGrants = [];
  fakeGrants = [...ALL_GRID];
  fakeScopes = {};
});

describe('GET / — quote gate', () => {
  it('403s a quote list for a caller without quoteGridDocument:read (order docs alone are not enough)', async () => {
    fakeGrants = ['orderGridDocument:read'];
    const res = await req('/?entity_type=quote&entity_id=1');
    expect(res.status).toBe(403);
    expect(mockListDocuments).not.toHaveBeenCalled();
  });

  it('200s a quote list for a caller holding quoteGridDocument:read', async () => {
    mockListDocuments.mockResolvedValue([{ document_id: 1, entity_type: 'quote' }]);
    const res = await req('/?entity_type=quote&entity_id=1');
    expect(res.status).toBe(200);
    expect(mockListDocuments).toHaveBeenCalled();
  });

  it('order lists are unaffected by the quote gate even with no quote grants', async () => {
    fakeGrants = ['orderGridDocument:read', 'orderGridDocument:write'];
    mockListDocuments.mockResolvedValue([{ document_id: 1, entity_type: 'order', doc_type: 'packing_slip' }]);
    const res = await req('/?entity_type=order&entity_id=1');
    expect(res.status).toBe(200);
  });
});

describe('POST / — quote gate', () => {
  const body = { entityType: 'quote', storageBucket: 'record-docs', fileName: 'a.pdf' };

  it('403s creating a quote document without quoteGridDocument:create', async () => {
    fakeGrants = ['quoteGridDocument:read', 'quoteGridDocument:write'];
    const res = await req('/', json('POST', body));
    expect(res.status).toBe(403);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('201s when the caller holds quoteGridDocument:create', async () => {
    mockCreateDocument.mockResolvedValue({ document_id: 1, ...body });
    const res = await req('/', json('POST', body));
    expect(res.status).toBe(201);
  });

  it('kicks off content indexing in the background without delaying the response', async () => {
    mockCreateDocument.mockResolvedValue({ document_id: 1, storage_bucket: 'record-docs', storage_path: 'quote/1/a.pdf', mime_type: 'application/pdf', file_name: 'a.pdf' });
    const waitUntilSpy = vi.spyOn(EXECUTION_CTX, 'waitUntil');
    const res = await req('/', json('POST', body));
    expect(res.status).toBe(201);
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /:id — quote gate', () => {
  it('403s editing a quote document without quoteGridDocument:write, before any update is attempted', async () => {
    fakeGrants = ['quoteGridDocument:read', 'quoteGridDocument:create'];
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'quote' });
    const res = await req('/1', json('PUT', { description: 'x' }));
    expect(res.status).toBe(403);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('allows editing an order document unaffected by the quote gate', async () => {
    // No quote grid grant, but orderGridDocument:write is what lets an order
    // edit through (see resolveWriteAccess in documents.ts) — this proves
    // the quote gate specifically isn't what's blocking/allowing it.
    fakeGrants = ['orderGridDocument:write'];
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'order' });
    mockUpdateDocument.mockResolvedValue({ document_id: 1, entity_type: 'order' });
    const res = await req('/1', json('PUT', { description: 'x' }));
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:id — quote gate', () => {
  it('403s deleting a quote document without quoteGridDocument:delete, and never calls deleteDocument', async () => {
    fakeGrants = ['quoteGridDocument:read', 'quoteGridDocument:write'];
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'quote' });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('deletes when the caller holds quoteGridDocument:delete', async () => {
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'quote' });
    mockDeleteDocument.mockResolvedValue({ document_id: 1, entity_type: 'quote' });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('404s when the document does not exist, without checking the quote gate', async () => {
    fakeGrants = [];
    mockGetDocument.mockResolvedValue(null);
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

// canAccessQuoteDocs only checked the boolean quote:read/write grant, never
// its scope — an own-scoped caller could list/attach/edit/delete documents
// on ANY quote by id. quoteOwnedByCaller closes that the same way orders.ts
// scopes its own table.
describe('quote document ownership scoping (own scope)', () => {
  beforeEach(() => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    fakeScopes = Object.fromEntries(['read', 'create', 'write', 'delete'].map((a) => [`quoteGridDocument:${a}`, 'own']));
  });

  it("GET 404s a quote not belonging to the caller's visible reps", async () => {
    mockExecQuery.mockResolvedValue({ rows: [] }); // quoteOwnedByCaller finds no match
    const res = await req('/?entity_type=quote&entity_id=5');
    expect(res.status).toBe(404);
    expect(mockListDocuments).not.toHaveBeenCalled();
  });

  it('GET 200s the caller\'s own quote', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ x: 1 }] });
    mockListDocuments.mockResolvedValue([{ document_id: 1, entity_type: 'quote' }]);
    const res = await req('/?entity_type=quote&entity_id=5');
    expect(res.status).toBe(200);
    expect(mockExecQuery).toHaveBeenCalledWith(
      {},
      expect.stringContaining('FROM public.quote'),
      ['5', ['REP-123']],
      'documents.quoteOwnedByCaller'
    );
  });

  it("POST 403s attaching a document to a quote not belonging to the caller's visible reps", async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req(
      '/',
      json('POST', { entityType: 'quote', entityId: '5', storageBucket: 'record-docs', fileName: 'a.pdf' })
    );
    expect(res.status).toBe(403);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('PUT 403s editing a document on a quote not belonging to the caller', async () => {
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'quote', entity_id: '5' });
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/1', json('PUT', { description: 'x' }));
    expect(res.status).toBe(403);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('DELETE 403s deleting a document on a quote not belonging to the caller', async () => {
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'quote', entity_id: '5' });
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });
});

// A rep's order Documents tab: no orderGridDocument write grants (the role
// seed), type-filtered to REP_VISIBLE_ORDER_DOC_TYPES, and writable only via
// the "managing rep" bypass (managed_sales_rep_list_ids non-empty — see
// resolveWriteAccess in documents.ts).
describe('rep order documents', () => {
  const rep = { id: 'rep1', managed_sales_rep_list_ids: [] as string[] };
  const managingRep = { id: 'rep2', managed_sales_rep_list_ids: ['REP-2'] };

  beforeEach(() => {
    fakeGrants = ['orderGridDocument:read']; // rep role: read, never write
  });

  it('GET hides non-rep-visible doc types from a plain rep', async () => {
    currentUser = rep;
    mockListDocuments.mockResolvedValue([
      { document_id: 1, entity_type: 'order', doc_type: 'invoice' },
      { document_id: 2, entity_type: 'order', doc_type: 'credit_memo' },
    ]);
    const res = await req('/?entity_type=order&entity_id=1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ document_id: 1, entity_type: 'order', doc_type: 'invoice' }]);
  });

  it('POST is forbidden for a plain rep (no orderGridDocument:create, not managing anyone)', async () => {
    currentUser = rep;
    const res = await req(
      '/',
      json('POST', { entityType: 'order', storageBucket: 'record-docs', fileName: 'a.pdf', docType: 'invoice' })
    );
    expect(res.status).toBe(403);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('POST succeeds for a managing rep on an order belonging to a rep they manage', async () => {
    currentUser = managingRep;
    mockExecQuery.mockResolvedValue({ rows: [{ x: 1 }] }); // managesOrderRep: order 42 belongs to REP-2
    mockCreateDocument.mockResolvedValue({ document_id: 1, entity_type: 'order', doc_type: 'invoice' });
    const res = await req(
      '/',
      json('POST', { entityType: 'order', entityId: '42', storageBucket: 'record-docs', fileName: 'a.pdf', docType: 'invoice' })
    );
    expect(res.status).toBe(201);
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining('FROM public.qb_sales_order'),
      ['42', ['REP-2']],
      'documents.managesOrderRep'
    );
  });

  it('POST still rejects a doc_type outside the rep-visible set for a managing rep', async () => {
    currentUser = managingRep;
    mockExecQuery.mockResolvedValue({ rows: [{ x: 1 }] });
    const res = await req(
      '/',
      json('POST', { entityType: 'order', entityId: '42', storageBucket: 'record-docs', fileName: 'a.pdf', docType: 'credit_memo' })
    );
    expect(res.status).toBe(400);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('POST is forbidden for a managing rep on an order NOT belonging to a rep they manage (the fixed bug)', async () => {
    // Before the fix, isManagingRepOrder only checked "manages >=1 rep
    // anywhere", granting write access to every order company-wide. Now it
    // checks the SPECIFIC order's rep against managed_sales_rep_list_ids.
    currentUser = managingRep;
    mockExecQuery.mockResolvedValue({ rows: [] }); // order 99 belongs to some other, unmanaged rep
    const res = await req(
      '/',
      json('POST', { entityType: 'order', entityId: '99', storageBucket: 'record-docs', fileName: 'a.pdf', docType: 'invoice' })
    );
    expect(res.status).toBe(403);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });
});

describe('per-module Documents grid grants (migration 100)', () => {
  it('invoice documents need invoiceGridDocument:read — holding every other module grant is not enough', async () => {
    fakeGrants = ALL_GRID.filter((p) => !p.startsWith('invoiceGridDocument'));
    const res = await req('/?entity_type=invoice&entity_id=1');
    expect(res.status).toBe(403);
    expect(mockListDocuments).not.toHaveBeenCalled();
  });

  it('create without delete: can attach, cannot remove', async () => {
    fakeGrants = ['inventoryGridDocument:read', 'inventoryGridDocument:create'];
    mockCreateDocument.mockResolvedValue({ document_id: 1, entity_type: 'inventory' });
    const created = await req('/', json('POST', { entityType: 'inventory', entityId: '3', storageBucket: 'record-docs', fileName: 'a.pdf' }));
    expect(created.status).toBe(201);
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'inventory', entity_id: '3' });
    const del = await req('/1', { method: 'DELETE' });
    expect(del.status).toBe(403);
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });
});
