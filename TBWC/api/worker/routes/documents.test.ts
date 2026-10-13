import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable auth + a minimal PermissionSet stand-in (just .has(), which is
// all this route reads off it) — real resolution is framework-tested
// elsewhere (permissions.ts). No is_admin anywhere: documents.ts reads real
// grants only (document:write covers admin and employee identically).
let currentUser: any = { id: 'admin' };
let currentGrants: string[] = ['document:read', 'document:write'];
let fakeGrants: string[] = ['document:read', 'document:write', 'quote:read', 'quote:write'];
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
  currentGrants = ['document:read', 'document:write'];
  fakeGrants = ['document:read', 'document:write', 'quote:read', 'quote:write'];
  fakeScopes = {};
});

describe('GET / — quote gate', () => {
  it('403s an quote list for a caller with document:read but no quote:read', async () => {
    fakeGrants = [];
    const res = await req('/?entity_type=quote&entity_id=1');
    expect(res.status).toBe(403);
    expect(mockListDocuments).not.toHaveBeenCalled();
  });

  it('200s an quote list for a caller holding quote:read', async () => {
    mockListDocuments.mockResolvedValue([{ document_id: 1, entity_type: 'quote' }]);
    const res = await req('/?entity_type=quote&entity_id=1');
    expect(res.status).toBe(200);
    expect(mockListDocuments).toHaveBeenCalled();
  });

  it('order lists are unaffected by the quote gate even with no quote grants', async () => {
    fakeGrants = [];
    mockListDocuments.mockResolvedValue([{ document_id: 1, entity_type: 'order', doc_type: 'packing_slip' }]);
    const res = await req('/?entity_type=order&entity_id=1');
    expect(res.status).toBe(200);
  });
});

describe('POST / — quote gate', () => {
  const body = { entityType: 'quote', storageBucket: 'record-docs', fileName: 'a.pdf' };

  it('403s creating an quote document without quote:write', async () => {
    fakeGrants = ['quote:read'];
    const res = await req('/', json('POST', body));
    expect(res.status).toBe(403);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('201s when the caller holds quote:write', async () => {
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
  it('403s editing an quote document without quote:write, before any update is attempted', async () => {
    fakeGrants = ['quote:read'];
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'quote' });
    const res = await req('/1', json('PUT', { description: 'x' }));
    expect(res.status).toBe(403);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('allows editing an order document unaffected by the quote gate', async () => {
    // No quote:* grant, but document:write is what actually lets an order
    // edit through (see resolveWriteAccess in documents.ts) — this proves
    // the quote gate specifically isn't what's blocking/allowing it.
    fakeGrants = ['document:write'];
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'order' });
    mockUpdateDocument.mockResolvedValue({ document_id: 1, entity_type: 'order' });
    const res = await req('/1', json('PUT', { description: 'x' }));
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:id — quote gate', () => {
  it('403s deleting an quote document without quote:write, and never calls deleteDocument', async () => {
    fakeGrants = ['quote:read'];
    mockGetDocument.mockResolvedValue({ document_id: 1, entity_type: 'quote' });
    const res = await req('/1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('deletes when the caller holds quote:write', async () => {
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
    fakeScopes = { 'quote:read': 'own', 'quote:write': 'own' };
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

// A rep's order Documents tab: no document:write grant at all (the role
// seed), type-filtered to REP_VISIBLE_ORDER_DOC_TYPES, and writable only via
// the "managing rep" bypass (managed_sales_rep_list_ids non-empty — see
// resolveWriteAccess in documents.ts).
describe('rep order documents', () => {
  const rep = { id: 'rep1', managed_sales_rep_list_ids: [] as string[] };
  const managingRep = { id: 'rep2', managed_sales_rep_list_ids: ['REP-2'] };

  beforeEach(() => {
    currentGrants = ['document:read']; // rep role: read, never write
    fakeGrants = []; // no document:write grant either way
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

  it('POST is forbidden for a plain rep (no document:write, not managing anyone)', async () => {
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
