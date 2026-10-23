import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePermissions, fullAccess } from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from '../permissions';

// Same controllable-auth pattern as orders.test.ts/documents.test.ts — the
// real resolution (role_permission -> PermissionSet) is tested elsewhere;
// this file is about whether aiChat.ts's own gating (TOOL_PERMISSION,
// ownScopeClause, allowedDocEntityTypes) reacts correctly to a given set.
let currentUser: any = { id: 'admin', sales_rep_list_id: null };
let currentPermSet = fullAccess(PERMISSIONS);

vi.mock('../middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware')>();
  return {
    ...actual,
    authenticateToken: (c: any, next: any) => {
      c.set('user', currentUser);
      c.set('userId', currentUser.id);
      return next();
    },
    requirePermission: (permission: string) => (c: any, next: any) => {
      if (!currentPermSet.has(permission)) {
        return c.json({ success: false, message: 'Insufficient permissions' }, 403);
      }
      c.set('permissions', currentPermSet);
      return next();
    },
  };
});

// The per-isolate rate limiter is a module-level Map with no reset hook —
// bypass it here rather than risk cross-test coupling on a shared counter.
vi.mock('@meterit/framework-backend/api/base/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meterit/framework-backend/api/base/auth')>();
  return { ...actual, checkRateLimit: () => true };
});

const mockExecQuery = vi.fn();
const mockWithTransaction = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
  withTransaction: (...a: any[]) => mockWithTransaction(...a),
}));

const mockSearchDocumentsMetadata = vi.fn();
const mockSearchDocumentsContent = vi.fn();
vi.mock('@meterit/framework-backend/api/base/aiSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meterit/framework-backend/api/base/aiSearch')>();
  return {
    ...actual,
    searchDocumentsMetadata: (...a: any[]) => mockSearchDocumentsMetadata(...a),
    searchDocumentsContent: (...a: any[]) => mockSearchDocumentsContent(...a),
  };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

import Anthropic from '@anthropic-ai/sdk';
import aiChatApp from './aiChat';

const MockAnthropic = vi.mocked(Anthropic);
const ENV = { ANTHROPIC_API_KEY: 'test-key' } as any;

let mockCreate: ReturnType<typeof vi.fn>;

function post(body: any) {
  return aiChatApp.request(
    '/',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ENV
  );
}

/** Scripts the model to call `toolName` once, then give a plain text reply —
 *  the minimum round trip needed to inspect what executeTool actually did. */
function scriptOneToolCall(toolName: string, input: Record<string, any> = {}) {
  mockCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'call_1', name: toolName, input }] })
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }] });
}

/** The tool's raw JSON result string, as sent back to the model in the
 *  given messages.create call (1 = the follow-up call after the tool ran). */
function toolResultContent(callIndex: number): string {
  const messages = mockCreate.mock.calls[callIndex][0].messages;
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const block = m.content.find((b: any) => b.type === 'tool_result');
      if (block) return block.content;
    }
  }
  throw new Error('no tool_result block found in call ' + callIndex);
}

function toolNamesSent(): string[] {
  return mockCreate.mock.calls[0][0].tools.map((t: any) => t.name);
}

function grantSet(grants: { permission: string; scope?: 'own' | 'all' }[]) {
  return resolvePermissions(
    grants.map((g) => ({ permission: g.permission, scope: g.scope ?? 'all', hiddenFields: [] })),
    null,
    PERMISSIONS
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin', sales_rep_list_id: null };
  currentPermSet = fullAccess(PERMISSIONS);
  mockCreate = vi.fn();
  MockAnthropic.mockImplementation(
    class {
      messages = { create: mockCreate };
    } as any
  );
});

describe('tool visibility', () => {
  it('a full-access caller gets every non-rep tool, including run_sql_query', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    const names = toolNamesSent();
    for (const n of ['search_orders', 'search_quotes', 'search_invoices', 'search_inventory', 'search_documents', 'search_support_tickets', 'run_sql_query']) {
      expect(names).toContain(n);
    }
  });

  it('search_support_tickets is hidden without support:read', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    expect(toolNamesSent()).not.toContain('search_support_tickets');
  });

  it('search_support_tickets is visible with support:read', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'support:read' }]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    expect(toolNamesSent()).toContain('search_support_tickets');
  });

  it('drops every order tool when the caller has no order:read', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    const names = toolNamesSent();
    expect(names).not.toContain('search_orders');
    expect(names).not.toContain('search_order_lines');
    expect(names).not.toContain('search_orders_by_document');
    expect(names).not.toContain('get_order_documents');
    expect(names).not.toContain('email_order');
  });

  it('search_quotes needs quote:read specifically — quote:write alone is not enough', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'quote:write' }]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    const names = toolNamesSent();
    expect(names).not.toContain('search_quotes');
    expect(names).not.toContain('get_quote');
    expect(names).toContain('create_quote');
  });

  it('run_sql_query requires aichat:sql specifically — holding every other :read permission at all scope is not enough', async () => {
    currentPermSet = grantSet([
      { permission: 'aichat:use' },
      { permission: 'order:read' },
      { permission: 'quote:read' },
      { permission: 'invoice:read' },
      { permission: 'customer:read' },
      { permission: 'inventory:read' },
      ...['order', 'quote', 'invoice', 'inventory'].map((k) => ({ permission: `${k}GridDocument:read` })),
    ]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    expect(toolNamesSent()).not.toContain('run_sql_query');
  });

  it('search_documents is visible with resource:read alone (no Documents grid grant)', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'resource:read' }]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    expect(toolNamesSent()).toContain('search_documents');
    expect(toolNamesSent()).toContain('search_document_contents');
  });

  it('search_documents is hidden with neither a Documents grid grant nor resource:read', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    expect(toolNamesSent()).not.toContain('search_documents');
    expect(toolNamesSent()).not.toContain('search_document_contents');
  });

  it('a rep (aichat:use own scope) only ever gets the quote-wizard tool set, regardless of other grants held', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = grantSet([{ permission: 'aichat:use', scope: 'own' }, { permission: 'order:read', scope: 'own' }]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    await post({ message: 'hi' });
    expect(toolNamesSent().sort()).toEqual(
      ['add_quote_line', 'create_quote', 'get_quote', 'search_catalog', 'search_customers', 'set_quote_job_name'].sort()
    );
  });
});

describe('order/quote/invoice row scoping (ownScopeClause)', () => {
  it('search_orders filters by visibleRepListIds when order:read is own', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123', managed_sales_rep_list_ids: ['REP-456'] };
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'order:read', scope: 'own' }]);
    scriptOneToolCall('search_orders', { text: 'acme' });
    mockExecQuery.mockResolvedValue({ rows: [] });
    await post({ message: 'find acme orders' });
    const call = mockExecQuery.mock.calls.find(([, sql]: any[]) => sql.includes('FROM public.qb_sales_order'));
    expect(call![1]).toContain('sales_rep_list_id = ANY($');
    expect(call![2]).toContainEqual(['REP-123', 'REP-456']);
  });

  it('search_orders has no own-scope filter when order:read is all', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'order:read', scope: 'all' }]);
    scriptOneToolCall('search_orders', { text: 'acme' });
    mockExecQuery.mockResolvedValue({ rows: [] });
    await post({ message: 'find acme orders' });
    const call = mockExecQuery.mock.calls.find(([, sql]: any[]) => sql.includes('FROM public.qb_sales_order'));
    expect(call![1]).not.toContain('sales_rep_list_id = ANY($');
  });

  it('an unlinked own-scoped caller (no rep, manages nobody) gets a filter that matches nothing', async () => {
    currentUser = { id: 'emp1', sales_rep_list_id: null };
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'order:read', scope: 'own' }]);
    scriptOneToolCall('search_orders', { text: 'acme' });
    mockExecQuery.mockResolvedValue({ rows: [] });
    await post({ message: 'find acme orders' });
    const call = mockExecQuery.mock.calls.find(([, sql]: any[]) => sql.includes('FROM public.qb_sales_order'));
    expect(call![1]).toContain('1 = 0');
  });

  it('get_quote 404s a quote not belonging to the caller when quote:read is own — even though aichat:use is all (the fixed bug)', async () => {
    // Before the fix, this ownership check used aichat:use's own/all switch,
    // which is 'all' for any non-rep caller — so it never actually ran for
    // an employee/admin, regardless of their REAL quote:read scope.
    currentUser = { id: 'emp1', sales_rep_list_id: null, managed_sales_rep_list_ids: [] };
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'quote:read', scope: 'own' }]);
    scriptOneToolCall('get_quote', { quoteId: 5 });
    mockExecQuery.mockResolvedValue({ rows: [{ quote_id: 5, sales_rep_list_id: 'SOMEONE-ELSE' }] });
    await post({ message: 'show me quote 5' });
    expect(JSON.parse(toolResultContent(1)).error).toBe('Quote not found');
  });

  it('get_quote succeeds for the caller\'s own quote under the same own-scope grant', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123', managed_sales_rep_list_ids: [] };
    currentPermSet = grantSet([{ permission: 'aichat:use', scope: 'own' }, { permission: 'quote:read', scope: 'own' }]);
    scriptOneToolCall('get_quote', { quoteId: 5 });
    mockExecQuery
      .mockResolvedValueOnce({ rows: [{ quote_id: 5, ref_number: 'Q-5', sales_rep_list_id: 'REP-123', status: 'quote', total: 100 }] })
      .mockResolvedValueOnce({ rows: [] });
    await post({ message: 'show me quote 5' });
    const result = JSON.parse(toolResultContent(1));
    expect(result.error).toBeUndefined();
    expect(result.quote_id).toBe(5);
  });
});

describe('search_support_tickets row scoping', () => {
  it('filters by users_id when support:read is own', async () => {
    currentUser = { id: 'rep1' };
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'support:read', scope: 'own' }]);
    scriptOneToolCall('search_support_tickets', { text: 'SN-123' });
    mockExecQuery.mockResolvedValue({ rows: [] });
    await post({ message: 'any ticket for serial SN-123?' });
    const call = mockExecQuery.mock.calls.find(([, sql]: any[]) => sql.includes('FROM public.support_ticket'));
    expect(call![1]).toContain('users_id = $');
    expect(call![2]).toContain('rep1');
  });

  it('has no own-scope filter when support:read is all', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'support:read', scope: 'all' }]);
    scriptOneToolCall('search_support_tickets', { text: 'SN-123' });
    mockExecQuery.mockResolvedValue({ rows: [] });
    await post({ message: 'any ticket for serial SN-123?' });
    const call = mockExecQuery.mock.calls.find(([, sql]: any[]) => sql.includes('FROM public.support_ticket'));
    expect(call![1]).not.toContain('users_id = $');
  });

  it('matches serial_number, job_name, and other header fields', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'support:read', scope: 'all' }]);
    scriptOneToolCall('search_support_tickets', { text: 'SN-123' });
    mockExecQuery.mockResolvedValue({ rows: [{ support_ticket_id: 1, ticket_number: 'TK-000001' }] });
    await post({ message: 'any ticket for serial SN-123?' });
    const result = JSON.parse(toolResultContent(1));
    expect(result).toEqual([{ support_ticket_id: 1, ticket_number: 'TK-000001' }]);
    const call = mockExecQuery.mock.calls.find(([, sql]: any[]) => sql.includes('FROM public.support_ticket'));
    expect(call![1]).toContain('serial_number ILIKE');
    expect(call![1]).toContain('job_name ILIKE');
  });
});

describe('search_documents candidate fallback', () => {
  it('hands the model availableDocuments when nothing scored but documents exist', async () => {
    scriptOneToolCall('search_documents', { text: 'Dent PowerScout Manual' });
    mockSearchDocumentsMetadata.mockResolvedValue({
      matches: [],
      totalDocuments: 1,
      candidates: [{ documentId: 1, entityType: 'resource', fileName: 'Dent PowerScout Meters Owners Manual.pdf', docType: 'manual' }],
    });
    await post({ message: 'get me the Dent PowerScout Manual' });
    const result = JSON.parse(toolResultContent(1));
    expect(result.matches).toEqual([]);
    expect(result.availableDocuments).toEqual([
      { documentId: 1, entityType: 'resource', fileName: 'Dent PowerScout Meters Owners Manual.pdf', docType: 'manual' },
    ]);
    expect(result.note).toMatch(/availableDocuments/);
  });

  it('returns plain matches, not the fallback shape, when something scored', async () => {
    scriptOneToolCall('search_documents', { text: 'warranty' });
    mockSearchDocumentsMetadata.mockResolvedValue({
      matches: [{ documentId: 1, fileName: 'warranty.pdf', score: 10 }],
      totalDocuments: 1,
    });
    await post({ message: 'find the warranty doc' });
    const result = JSON.parse(toolResultContent(1));
    expect(result).toEqual([{ documentId: 1, fileName: 'warranty.pdf', score: 10 }]);
  });
});

describe('document search entity-type scoping (allowedDocEntityTypes)', () => {
  it('an own-scoped Documents grid read does not make that module searchable (free search cannot apply own scope)', async () => {
    currentPermSet = grantSet([
      { permission: 'aichat:use' },
      { permission: 'orderGridDocument:read' },
      { permission: 'quoteGridDocument:read', scope: 'own' },
    ]);
    scriptOneToolCall('search_documents', { text: 'guide' });
    mockSearchDocumentsMetadata.mockResolvedValue({ matches: [], totalDocuments: 0 });
    await post({ message: 'find the guide' });
    expect(mockSearchDocumentsMetadata).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'guide', { entityTypes: ['order'] });
  });

  it('includes order/quote/invoice/inventory plus resource when every Documents grid read and resource:read are held', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, ...['order', 'quote', 'invoice', 'inventory'].map((k) => ({ permission: `${k}GridDocument:read` })), { permission: 'resource:read' }]);
    scriptOneToolCall('search_documents', { text: 'guide' });
    mockSearchDocumentsMetadata.mockResolvedValue({ matches: [], totalDocuments: 0 });
    await post({ message: 'find the guide' });
    expect(mockSearchDocumentsMetadata).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'guide',
      { entityTypes: ['order', 'quote', 'invoice', 'inventory', 'resource'] }
    );
  });

  it('includes only resource when no Documents grid read is held', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'resource:read' }]);
    scriptOneToolCall('search_document_contents', { text: 'guide' });
    mockSearchDocumentsContent.mockResolvedValue({ results: [], scanned: 0, truncated: false });
    await post({ message: 'find the guide' });
    expect(mockSearchDocumentsContent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'guide',
      { entityTypes: ['resource'] }
    );
  });
});

// The Resources browser hides 'employee'-typed files from a caller without
// resource:write (docTypes.ts); asking the model instead must not be the way
// around that. docAccess.ts owns the rule for both.
describe("employee-only resource files in document search", () => {
  /** document_type rows + the resource document rows docAccess.ts reads. */
  function stubResourceTables() {
    mockExecQuery.mockImplementation((_env: any, sql: string) => {
      if (sql.includes('public.document_type')) {
        return { rows: [{ doc_path: 'Internal', doc_type: 'employee' }] };
      }
      if (sql.includes("entity_type = 'resource'")) {
        return {
          rows: [
            { document_id: 1, entity_id: 'Internal/margins.xlsx' },
            { document_id: 2, entity_id: 'Cutsheets/meter.pdf' },
          ],
        };
      }
      return { rows: [] };
    });
  }

  const MATCHES = [
    { documentId: 1, entityType: 'resource', fileName: 'margins.xlsx', score: 9 },
    { documentId: 2, entityType: 'resource', fileName: 'meter.pdf', score: 8 },
  ];

  it('are dropped from matches for a read-only caller', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'resource:read' }]);
    stubResourceTables();
    scriptOneToolCall('search_documents', { text: 'margins' });
    mockSearchDocumentsMetadata.mockResolvedValue({ matches: MATCHES, totalDocuments: 2 });
    await post({ message: 'find margins' });
    expect(JSON.parse(toolResultContent(1))).toEqual([MATCHES[1]]);
  });

  it('are dropped from the candidate fallback list too', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'resource:read' }]);
    stubResourceTables();
    scriptOneToolCall('search_documents', { text: 'nothing matches this' });
    mockSearchDocumentsMetadata.mockResolvedValue({
      matches: [],
      totalDocuments: 2,
      candidates: [
        { documentId: 1, entityType: 'resource', fileName: 'margins.xlsx', docType: 'other' },
        { documentId: 2, entityType: 'resource', fileName: 'meter.pdf', docType: 'other' },
      ],
    });
    await post({ message: 'find it' });
    const result = JSON.parse(toolResultContent(1));
    expect(result.availableDocuments.map((d: any) => d.documentId)).toEqual([2]);
  });

  it('are dropped from content snippets', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'resource:read' }]);
    stubResourceTables();
    scriptOneToolCall('search_document_contents', { text: 'margin' });
    mockSearchDocumentsContent.mockResolvedValue({
      results: MATCHES.map((m) => ({ ...m, snippet: 'hit' })),
      scanned: 2,
      truncated: false,
    });
    await post({ message: 'search contents' });
    expect(JSON.parse(toolResultContent(1)).map((r: any) => r.documentId)).toEqual([2]);
  });

  it('stay visible for a caller holding resource:write', async () => {
    currentPermSet = grantSet([
      { permission: 'aichat:use' },
      { permission: 'resource:read' },
      { permission: 'resource:write' },
    ]);
    stubResourceTables();
    scriptOneToolCall('search_documents', { text: 'margins' });
    mockSearchDocumentsMetadata.mockResolvedValue({ matches: MATCHES, totalDocuments: 2 });
    await post({ message: 'find margins' });
    expect(JSON.parse(toolResultContent(1))).toEqual(MATCHES);
  });
});

describe('run_sql_query', () => {
  it('runs for a caller holding aichat:sql', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }, { permission: 'aichat:sql' }]);
    scriptOneToolCall('run_sql_query', { sql: 'SELECT 1' });
    mockExecQuery.mockResolvedValue({ rows: [{ x: 1 }] });
    await post({ message: 'run a query' });
    expect(toolNamesSent()).toContain('run_sql_query');
    expect(mockExecQuery).toHaveBeenCalled();
  });

  it('refuses even if somehow invoked without aichat:sql (defense in depth, not just tool-list filtering)', async () => {
    currentPermSet = grantSet([{ permission: 'aichat:use' }]);
    scriptOneToolCall('run_sql_query', { sql: 'SELECT 1' });
    await post({ message: 'run a query' });
    expect(JSON.parse(toolResultContent(1)).error).toBe('Not permitted');
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});
