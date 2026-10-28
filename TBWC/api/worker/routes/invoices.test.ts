import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePermissions, fullAccess } from '@meterit/framework-backend/api/base/permissions';
import { PERMISSIONS } from '../permissions';

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

const mockFindAll = vi.fn();
const mockFindById = vi.fn();
const mockUpdate = vi.fn();
vi.mock('../crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crud')>();
  return {
    ...actual,
    findAll: (...a: any[]) => mockFindAll(...a),
    findById: (...a: any[]) => mockFindById(...a),
    update: (...a: any[]) => mockUpdate(...a),
  };
});

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

// The notice-email send: sendMail/putObject/createDocument are stubbed so
// nothing reaches Supabase Storage, the mail edge fn, or a real document
// insert — buildDocumentPdf (pdf-lib) still runs for real, same as the
// GET /:id/pdf tests below.
const mockSendMail = vi.fn();
vi.mock('../mail', () => ({
  sendMail: (...a: any[]) => mockSendMail(...a),
}));

const mockPutObject = vi.fn();
vi.mock('../storageAdmin', () => ({
  putObject: (...a: any[]) => mockPutObject(...a),
}));

const mockCreateDocument = vi.fn();
vi.mock('@meterit/framework-backend/api/base/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meterit/framework-backend/api/base/documents')>();
  return {
    ...actual,
    createDocument: (...a: any[]) => mockCreateDocument(...a),
  };
});

import invoicesApp from './invoices';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => invoicesApp.request(path, init, ENV);

const put = (path: string, body: any) =>
  req(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const post = (path: string, body: any) =>
  req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** The AR columns a PUT is allowed to set. */
const AR_FIELDS = {
  notice_1_date: '2026-09-15', notice_1_method: 'email', notice_1_note: 'emailed AP',
  notice_2_date: '2026-10-01', notice_2_method: 'phone', notice_2_note: 'left voicemail',
  notice_3_date: null, notice_3_method: null, notice_3_note: null,
  ar_notes: 'promised payment by month end',
  late_fee_applied: true,
};

function repPermSet() {
  return resolvePermissions([{ permission: 'invoice:read', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
}

function repWritePermSet() {
  return resolvePermissions([{ permission: 'invoice:write', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'admin', sales_rep_list_id: null };
  currentPermSet = fullAccess(PERMISSIONS);
});

describe('permission gate', () => {
  it('403s without invoice:read', async () => {
    currentPermSet = resolvePermissions([], null, PERMISSIONS);
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockFindAll).not.toHaveBeenCalled();
  });
});

describe('GET / scoping', () => {
  it('admin (all scope) sees every invoice, no rep filter', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].where).toEqual({ qb_deleted_at: null });
  });

  it('always excludes packing slips', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].whereNot).toEqual({ is_packing_slip: true });
  });

  it('joins qb_sales_rep so the list carries a sales_rep name', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.joins).toContain('LEFT JOIN public.qb_sales_rep');
    expect(opts.selectFields).toContain('qb_sales_rep.name AS sales_rep');
  });

  it("a rep (own scope) is filtered to their linked sales_rep_list_id", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.where).toEqual({ qb_deleted_at: null });
    expect(opts.whereRaw).toEqual([{ sql: 'sales_rep_list_id IN (?)', params: ['REP-123'] }]);
  });

  it('a rep who manages others is scoped to their own rep plus every managed rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123', managed_sales_rep_list_ids: ['REP-456'] };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].whereRaw).toEqual([
      { sql: 'sales_rep_list_id IN (?, ?)', params: ['REP-123', 'REP-456'] },
    ]);
  });

  it('an unlinked rep (manages nobody) gets a filter that can never match a real invoice', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].whereRaw).toEqual([{ sql: '1 = 0' }]);
  });

  it('a crafted sales_rep_list_id query param cannot widen a rep\'s scope', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?sales_rep_list_id=SOMEONE-ELSE');
    expect(mockFindAll.mock.calls[0][1].whereRaw).toEqual([{ sql: 'sales_rep_list_id IN (?)', params: ['REP-123'] }]);
  });

  it('passes txn_date_from/txn_date_to as a whereRange, not an exact-match field', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?txn_date_from=2026-09-01&txn_date_to=2026-09-24');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRange).toEqual({ txn_date: { gte: '2026-09-01', lte: '2026-09-24' } });
    expect(opts.where).toEqual({ qb_deleted_at: null });
  });

  it('omits whereRange entirely when neither date bound is given', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    expect(mockFindAll.mock.calls[0][1].whereRange).toBeUndefined();
  });

  it('selects days_past_due/total_past_due as computed columns', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/');
    const { selectFields } = mockFindAll.mock.calls[0][1];
    expect(selectFields).toContain('AS days_past_due');
    expect(selectFields).toContain('AS total_past_due');
    // Only an invoice that still owes money past its due date counts as late.
    expect(selectFields).toContain('due_date < CURRENT_DATE');
    expect(selectFields).toContain('COALESCE("qb_invoice".balance_remaining, 0) > 0');
  });

  it('reads ?days_past_due as a minimum, on top of the rep scope', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?days_past_due=60');
    const opts = mockFindAll.mock.calls[0][1];
    // Never an exact-match field filter — that would be SQL against a column
    // qb_invoice doesn't have.
    expect(opts.where).toEqual({ qb_deleted_at: null });
    expect(opts.whereRaw).toHaveLength(2);
    expect(opts.whereRaw[0]).toEqual({ sql: 'sales_rep_list_id IN (?)', params: ['REP-123'] });
    expect(opts.whereRaw[1].sql).toContain('>= ?');
    expect(opts.whereRaw[1].params).toEqual([60]);
  });

  it('applies both bounds for a closed aging band', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?days_past_due=30&days_past_due_max=59');
    const { whereRaw, where } = mockFindAll.mock.calls[0][1];
    expect(where).toEqual({ qb_deleted_at: null });
    expect(whereRaw).toHaveLength(2);
    expect(whereRaw[0].sql).toContain('>= ?');
    expect(whereRaw[0].params).toEqual([30]);
    expect(whereRaw[1].sql).toContain('<= ?');
    expect(whereRaw[1].params).toEqual([59]);
  });

  it('ignores a non-numeric ?days_past_due instead of passing it to SQL', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?days_past_due=soon');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.whereRaw).toEqual([]);
    expect(opts.where).toEqual({ qb_deleted_at: null });
  });

  it('ignores a non-numeric ?days_past_due_max too', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?days_past_due_max=later');
    expect(mockFindAll.mock.calls[0][1].whereRaw).toEqual([]);
  });

  it('never lets total_past_due reach SQL as a column comparison', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?total_past_due=100');
    expect(mockFindAll.mock.calls[0][1].where).toEqual({ qb_deleted_at: null });
  });

  it('sorts a computed column through orderBy, not findAll sortBy', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?sortBy=days_past_due&sortOrder=asc');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.sortBy).toBeUndefined();
    expect(opts.orderBy).toContain('ASC NULLS LAST');
    expect(opts.orderBy).toContain('CURRENT_DATE');
  });

  it('sorts the joined sales_rep name through orderBy too', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?sortBy=sales_rep');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.sortBy).toBeUndefined();
    expect(opts.orderBy).toBe('qb_sales_rep.name DESC NULLS LAST');
  });

  it('leaves a real column to findAll sortBy', async () => {
    mockFindAll.mockResolvedValue({ rows: [], pagination: { total: 0 } });
    await req('/?sortBy=ref_number&sortOrder=asc');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.sortBy).toBe('ref_number');
    expect(opts.orderBy).toBeUndefined();
  });

  it('does not redact any columns for the owning rep (unlike orders)', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindAll.mockResolvedValue({
      rows: [{ qb_invoice_id: 1, total: 500, balance_remaining: 500, is_paid: false }],
      pagination: { total: 1 },
    });
    const res = await req('/');
    expect((await res.json()).data.items).toEqual([
      { qb_invoice_id: 1, total: 500, balance_remaining: 500, is_paid: false },
    ]);
  });
});

describe('GET /receivables-summary scoping', () => {
  it('admin (all scope) passes a null rep filter', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{}] });
    await req('/receivables-summary?year=2026');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([null, 2026]);
    expect(mockExecQuery.mock.calls[1][2]).toEqual([null]);
  });

  it('a rep who manages others is scoped to their own rep plus every managed rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123', managed_sales_rep_list_ids: ['REP-456'] };
    currentPermSet = repPermSet();
    mockExecQuery.mockResolvedValue({ rows: [{}] });
    await req('/receivables-summary?year=2026');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([['REP-123', 'REP-456'], 2026]);
  });

  it('an unlinked rep (manages nobody) gets an empty rep list, not an unscoped null', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockExecQuery.mockResolvedValue({ rows: [{}] });
    await req('/receivables-summary?year=2026');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([[], 2026]);
  });
});

describe('PUT /:id (AR tab)', () => {
  beforeEach(() => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: null, customer_list_id: 'CUST-1' });
    mockUpdate.mockResolvedValue({});
    mockExecQuery.mockResolvedValue({ rows: [{ adp: 42 }] });
  });

  it('403s without invoice:write', async () => {
    currentPermSet = resolvePermissions([{ permission: 'invoice:read', scope: 'all', hiddenFields: [] }], null, PERMISSIONS);
    const res = await put('/1', AR_FIELDS);
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('writes every AR field', async () => {
    const res = await put('/1', AR_FIELDS);
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0][4]).toEqual(AR_FIELDS);
  });

  it('drops QB-owned columns from the payload instead of writing them', async () => {
    await put('/1', { ...AR_FIELDS, total: 999, balance_remaining: 0, is_paid: true, customer_name: 'Hacked' });
    const data = mockUpdate.mock.calls[0][4];
    expect(data).toEqual(AR_FIELDS);
    for (const qbField of ['total', 'balance_remaining', 'is_paid', 'customer_name']) {
      expect(data).not.toHaveProperty(qbField);
    }
  });

  it('drops the computed aging aliases too', async () => {
    await put('/1', { ar_notes: 'x', days_past_due: 1, total_past_due: 1, sales_rep: 'Someone' });
    expect(mockUpdate.mock.calls[0][4]).toEqual({ ar_notes: 'x' });
  });

  it('coerces late_fee_applied to a real boolean (the column is NOT NULL)', async () => {
    await put('/1', { late_fee_applied: 'true' });
    expect(mockUpdate.mock.calls[0][4]).toEqual({ late_fee_applied: true });
    mockUpdate.mockClear();
    // An emptied control must not try to write NULL into a NOT NULL column.
    await put('/1', { late_fee_applied: '' });
    expect(mockUpdate.mock.calls[0][4]).toEqual({ late_fee_applied: false });
  });

  it('400s an out-of-set notice method', async () => {
    const res = await put('/1', { notice_1_method: 'carrier pigeon' });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('treats an empty method/date as clearing the field, not an invalid value', async () => {
    const res = await put('/1', { notice_1_method: '', notice_1_date: '' });
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0][4]).toEqual({ notice_1_method: null, notice_1_date: null });
  });

  it('skips the UPDATE entirely when nothing writable was sent', async () => {
    const res = await put('/1', { total: 999 });
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('404s a soft-deleted invoice', async () => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: '2026-01-01' });
    const res = await put('/1', AR_FIELDS);
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("404s (not 403) when an own-scoped writer targets another rep's invoice", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = resolvePermissions([{ permission: 'invoice:write', scope: 'own', hiddenFields: [] }], null, PERMISSIONS);
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: null, sales_rep_list_id: 'OTHER-REP' });
    const res = await put('/1', AR_FIELDS);
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  describe('notice lock (an email already sent for that slot)', () => {
    it('drops date/method for a slot already emailed, but keeps the note writable', async () => {
      mockFindById.mockResolvedValue({
        qb_invoice_id: 1, qb_deleted_at: null, customer_list_id: 'CUST-1',
        notice_1_date: '2026-09-01', notice_1_method: 'email',
      });
      const res = await put('/1', { notice_1_date: '2026-10-01', notice_1_method: 'phone', notice_1_note: 'called too' });
      expect(res.status).toBe(200);
      expect(mockUpdate.mock.calls[0][4]).toEqual({ notice_1_note: 'called too' });
    });

    it('leaves a phone-logged notice freely editable', async () => {
      mockFindById.mockResolvedValue({
        qb_invoice_id: 1, qb_deleted_at: null, customer_list_id: 'CUST-1',
        notice_1_date: '2026-09-01', notice_1_method: 'phone',
      });
      const res = await put('/1', { notice_1_date: '2026-10-01', notice_1_method: 'email' });
      expect(res.status).toBe(200);
      expect(mockUpdate.mock.calls[0][4]).toEqual({ notice_1_date: '2026-10-01', notice_1_method: 'email' });
    });

    it('leaves a never-sent slot freely editable', async () => {
      mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: null, customer_list_id: 'CUST-1' });
      const res = await put('/1', { notice_2_date: '2026-10-01', notice_2_method: 'email' });
      expect(res.status).toBe(200);
      expect(mockUpdate.mock.calls[0][4]).toEqual({ notice_2_date: '2026-10-01', notice_2_method: 'email' });
    });
  });
});

describe('POST /:id/notice-email', () => {
  const NOTICE_ROW = {
    ref_number: 'INV-1', customer_name: 'Acme Co', txn_date: '2026-09-01', due_date: '2026-09-15',
    total: 500, balance_remaining: 500, lines: [], sales_rep_list_id: 'REP-123',
    notice_1_date: null, notice_1_method: null,
    notice_2_date: null, notice_2_method: null,
    notice_3_date: null, notice_3_method: null,
    bill_addr: null, customer_email: 'cust@example.com',
  };

  beforeEach(() => {
    mockExecQuery.mockResolvedValue({ rows: [NOTICE_ROW] });
    mockPutObject.mockResolvedValue(undefined);
    mockCreateDocument.mockResolvedValue({ document_id: 1 });
    mockUpdate.mockResolvedValue({});
    mockSendMail.mockResolvedValue(undefined);
  });

  it('sends notice 1 for a never-noticed invoice, locks it, and records a document', async () => {
    const res = await post('/1/notice-email', { sentDate: '2026-09-20' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      notice: 1, recipient: 'cust@example.com', refNumber: 'INV-1', documented: true,
    });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][1].email).toBe('cust@example.com');
    expect(mockCreateDocument.mock.calls[0][2]).toMatchObject({
      entityType: 'invoice', entityId: '1', docType: 'email', storageBucket: 'record-docs',
    });
    expect(mockUpdate.mock.calls[0][4]).toEqual({ notice_1_date: '2026-09-20', notice_1_method: 'email' });
  });

  it('picks the next unsent slot, skipping ones already used (by either method)', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ ...NOTICE_ROW, notice_1_date: '2026-09-01', notice_1_method: 'phone' }] });
    const res = await post('/1/notice-email', {});
    expect((await res.json()).data.notice).toBe(2);
    expect(mockUpdate.mock.calls[0][4]).toMatchObject({ notice_2_method: 'email' });
  });

  it('400s once all 3 notices are already sent, before ever sending mail', async () => {
    mockExecQuery.mockResolvedValue({
      rows: [{ ...NOTICE_ROW, notice_1_date: '2026-01-01', notice_2_date: '2026-02-01', notice_3_date: '2026-03-01' }],
    });
    const res = await post('/1/notice-email', {});
    expect(res.status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('400s with no email on file, before ever sending mail', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ ...NOTICE_ROW, customer_email: null }] });
    const res = await post('/1/notice-email', {});
    expect(res.status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("404s for an own-scoped caller who doesn't own the invoice, before ever sending mail", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repWritePermSet();
    mockExecQuery.mockResolvedValue({ rows: [{ ...NOTICE_ROW, sales_rep_list_id: 'OTHER-REP' }] });
    const res = await post('/9/notice-email', {});
    expect(res.status).toBe(404);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('502s when the send itself fails, and never locks or documents it', async () => {
    mockSendMail.mockRejectedValue(new Error('send-mail failed (500)'));
    const res = await post('/1/notice-email', {});
    expect(res.status).toBe(502);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('still reports the notice sent (and still locks it) if the document record fails', async () => {
    mockCreateDocument.mockRejectedValue(new Error('storage down'));
    const res = await post('/1/notice-email', {});
    expect(res.status).toBe(200);
    expect((await res.json()).data.documented).toBe(false);
    expect(mockUpdate).toHaveBeenCalled();
  });
});

describe('POST /notice-email/bulk', () => {
  beforeEach(() => {
    mockPutObject.mockResolvedValue(undefined);
    mockCreateDocument.mockResolvedValue({ document_id: 1 });
    mockUpdate.mockResolvedValue({});
    mockSendMail.mockResolvedValue(undefined);
  });

  it('400s with no invoiceIds', async () => {
    const res = await post('/notice-email/bulk', {});
    expect(res.status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('sends each invoice independently and reports a per-row result', async () => {
    mockExecQuery.mockImplementation(async (_env: any, _sql: string, params: any[]) => {
      if (params[0] === '1') {
        return { rows: [{ ref_number: 'INV-1', lines: [], customer_email: 'a@x.com', notice_1_date: null }] };
      }
      if (params[0] === '2') {
        return { rows: [{ ref_number: 'INV-2', lines: [], customer_email: null, notice_1_date: null }] };
      }
      return { rows: [] };
    });
    const res = await post('/notice-email/bulk', { invoiceIds: ['1', '2', '3'] });
    expect(res.status).toBe(200);
    expect((await res.json()).data.results).toEqual([
      { id: '1', success: true, notice: 1, recipient: 'a@x.com' },
      { id: '2', success: false, message: 'No email on file for this customer' },
      { id: '3', success: false, message: 'Invoice not found' },
    ]);
    // Only the one eligible invoice (id 1) actually went out.
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('avg days to pay', () => {
  it('is derived on the detail route and returned with the record', async () => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: null, customer_list_id: 'CUST-1' });
    mockExecQuery.mockResolvedValue({ rows: [{ adp: 42 }] });
    const res = await req('/1');
    expect((await res.json()).data.avg_days_to_pay).toBe(42);
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(params).toEqual(['CUST-1']);
    // Prepayments (negative spans) never drag the average down.
    expect(sql).toContain('days >= 0');
  });

  it('is null for a customer who has never paid an invoice', async () => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: null, customer_list_id: 'CUST-1' });
    mockExecQuery.mockResolvedValue({ rows: [{ adp: null }] });
    const res = await req('/1');
    expect((await res.json()).data.avg_days_to_pay).toBeNull();
  });

  it('is null (and runs no query) for an invoice with no customer', async () => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: null, customer_list_id: null });
    const res = await req('/1');
    expect((await res.json()).data.avg_days_to_pay).toBeNull();
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('is never computed for the list', async () => {
    mockFindAll.mockResolvedValue({ rows: [{ qb_invoice_id: 1 }], pagination: { total: 1 } });
    await req('/');
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('GET /:id', () => {
  it('joins qb_sales_rep so the form carries a sales_rep name', async () => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: null });
    await req('/1');
    const [, , , , , selectFields, joins] = mockFindById.mock.calls[0];
    expect(joins).toContain('LEFT JOIN public.qb_sales_rep');
    expect(selectFields).toContain('qb_sales_rep.name AS sales_rep');
  });

  it('joins qb_customer so the AR tab can email/call the customer', async () => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: null });
    await req('/1');
    const [, , , , , selectFields, joins] = mockFindById.mock.calls[0];
    expect(joins).toContain('LEFT JOIN public.qb_customer ON qb_customer.list_id');
    expect(selectFields).toContain('qb_customer.email AS customer_email');
    expect(selectFields).toContain('qb_customer.phone AS customer_phone');
  });

  it('keeps customer contact off the list payload', async () => {
    mockFindAll.mockResolvedValue({ rows: [{ qb_invoice_id: 1 }], pagination: { total: 1 } });
    await req('/');
    const opts = mockFindAll.mock.calls[0][1];
    expect(opts.joins).not.toContain('qb_customer');
    expect(opts.selectFields).not.toContain('customer_email');
  });

  it('404s a soft-deleted invoice', async () => {
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, qb_deleted_at: '2026-01-01' });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it("404s (not 403) when a rep requests another rep's invoice", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, sales_rep_list_id: 'OTHER-REP', qb_deleted_at: null });
    const res = await req('/1');
    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe('Invoice not found');
  });

  it('404s an unlinked rep even for an invoice with no assigned rep (both null)', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: null };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, sales_rep_list_id: null, qb_deleted_at: null });
    const res = await req('/1');
    expect(res.status).toBe(404);
  });

  it('returns the full row (no redaction) for the owning rep', async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockFindById.mockResolvedValue({ qb_invoice_id: 1, sales_rep_list_id: 'REP-123', qb_deleted_at: null, total: 500 });
    const res = await req('/1');
    expect(res.status).toBe(200);
    expect((await res.json()).data.total).toBe(500);
  });
});

describe('GET /:id/pdf', () => {
  const PDF_ROW = {
    ref_number: 'INV-1042', customer_name: 'Acme Co', txn_date: '2026-09-01', due_date: '2026-10-01',
    total: 500, lines: [], sales_rep_list_id: 'REP-123', bill_addr: null,
  };

  it('builds and returns a PDF for an invoice the caller can see', async () => {
    mockExecQuery.mockResolvedValue({ rows: [PDF_ROW] });
    const res = await req('/1/pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    // Filename comes from the invoice's own ref_number, not the row id.
    expect(res.headers.get('Content-Disposition')).toContain('Invoice-INV-1042.pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // %PDF — real pdf-lib output, not a stub.
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
  });

  it('404s when no such invoice exists', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/999/pdf');
    expect(res.status).toBe(404);
  });

  it("404s (not 403) when a rep requests another rep's invoice PDF", async () => {
    currentUser = { id: 'rep1', sales_rep_list_id: 'REP-123' };
    currentPermSet = repPermSet();
    mockExecQuery.mockResolvedValue({ rows: [{ ...PDF_ROW, sales_rep_list_id: 'OTHER-REP' }] });
    const res = await req('/1/pdf');
    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe('Invoice not found');
  });

  it('falls back to the row id in the filename when QB never gave this invoice a ref number', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ ...PDF_ROW, ref_number: null }] });
    const res = await req('/1/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('Invoice-1.pdf');
  });
});
