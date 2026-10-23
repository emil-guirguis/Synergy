/**
 * The header search bar must see exactly what the caller's role allows — the
 * same rule as the AI chat's document tools. Before this it ran on
 * authenticateToken alone and searched every document row in the system.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Grants the fake caller holds, as permission -> scope. */
let grants: Record<string, 'all' | 'own'> = {};

const permissionSet = () => ({
  has: (p: string) => p in grants,
  scopeOf: (p: string) => grants[p] ?? null,
  hiddenFields: () => [],
  readOnlyFields: () => [],
  list: () => [],
});

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', { id: 'u', email: 'u@example.com' });
    c.set('userId', 'u');
    return next();
  },
  permissionsFor: async () => permissionSet(),
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

const mockMetadata = vi.fn();
const mockContent = vi.fn();
vi.mock('@meterit/framework-backend/api/base/aiSearch', () => ({
  searchDocumentsMetadata: (...a: any[]) => mockMetadata(...a),
  searchDocumentsContent: (...a: any[]) => mockContent(...a),
}));

import aiSearchApp from './aiSearch';

const ENV = {} as any;
const post = (path: string, body: unknown) =>
  aiSearchApp.request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ENV
  );

const doc = (documentId: number, entityId: string, entityType = 'resource') => ({
  documentId,
  entityType,
  entityId,
  fileName: `${entityId.split('/').pop()}`,
  mimeType: 'application/pdf',
  docType: 'other',
  storageBucket: 'rep-docs',
  storagePath: entityId,
  fileSize: 1,
  score: 5,
  snippet: 'hit',
});

/** document_type rows, then the resource document rows docAccess.ts reads. */
function stubResourceTables(types: [string, string][], docs: { document_id: number; entity_id: string }[]) {
  mockExecQuery.mockImplementation((_env: any, sql: string) => {
    if (sql.includes('public.document_type')) {
      return { rows: types.map(([doc_path, doc_type]) => ({ doc_path, doc_type })) };
    }
    if (sql.includes("entity_type = 'resource'")) return { rows: docs };
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  grants = {};
  mockExecQuery.mockResolvedValue({ rows: [] });
  mockMetadata.mockResolvedValue({ matches: [], totalDocuments: 0 });
  mockContent.mockResolvedValue({ results: [], scanned: 0, truncated: false });
});

describe('entity type allowlist', () => {
  it('searches nothing for a caller with no document grants at all', async () => {
    const res = await post('/', { query: 'manual' });
    expect(res.status).toBe(200);
    expect(mockMetadata.mock.calls[0][3]).toEqual({ entityTypes: [] });
  });

  it('a rep with resource:read searches the resource library only', async () => {
    grants = { 'resource:read': 'all', 'orderGridDocument:read': 'own' };
    await post('/', { query: 'manual' });
    expect(mockMetadata.mock.calls[0][3]).toEqual({ entityTypes: ['resource'] });
  });

  it('an own-scoped Documents grant does not make that module searchable', async () => {
    grants = { 'quoteGridDocument:read': 'own', 'orderGridDocument:read': 'all' };
    await post('/', { query: 'manual' });
    expect(mockMetadata.mock.calls[0][3]).toEqual({ entityTypes: ['order'] });
  });

  it('applies the same allowlist to the content pass', async () => {
    grants = { 'invoiceGridDocument:read': 'all', 'resource:read': 'all' };
    await post('/content', { query: 'serial' });
    expect(mockContent.mock.calls[0][3]).toEqual({ entityTypes: ['invoice', 'resource'] });
  });
});

describe("the resource library's employee-only files", () => {
  beforeEach(() => {
    stubResourceTables(
      [['Internal', 'employee'], ['Cutsheets', 'all']],
      [
        { document_id: 1, entity_id: 'Internal/margins.xlsx' },
        { document_id: 2, entity_id: 'Cutsheets/meter.pdf' },
      ]
    );
  });

  it('are dropped for a read-only caller, inherited from their folder', async () => {
    grants = { 'resource:read': 'all' };
    mockMetadata.mockResolvedValue({
      matches: [doc(1, 'Internal/margins.xlsx'), doc(2, 'Cutsheets/meter.pdf')],
      totalDocuments: 2,
    });
    const body: any = await (await post('/', { query: 'x' })).json();
    expect(body.data.results.map((r: any) => r.id)).toEqual([2]);
  });

  it('are dropped from content snippets too', async () => {
    grants = { 'resource:read': 'all' };
    mockContent.mockResolvedValue({
      results: [doc(1, 'Internal/margins.xlsx'), doc(2, 'Cutsheets/meter.pdf')],
      scanned: 2,
      truncated: false,
    });
    const body: any = await (await post('/content', { query: 'x' })).json();
    expect(body.data.results.map((r: any) => r.id)).toEqual([2]);
  });

  it('stay visible for a caller with resource:write, without the extra lookups', async () => {
    grants = { 'resource:read': 'all', 'resource:write': 'all' };
    mockMetadata.mockResolvedValue({
      matches: [doc(1, 'Internal/margins.xlsx'), doc(2, 'Cutsheets/meter.pdf')],
      totalDocuments: 2,
    });
    const body: any = await (await post('/', { query: 'x' })).json();
    expect(body.data.results.map((r: any) => r.id)).toEqual([1, 2]);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});
