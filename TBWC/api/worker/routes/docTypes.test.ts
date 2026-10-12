import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentGrants: string[] = ['resource:read', 'resource:write'];

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', { id: 'admin' });
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) => {
    if (!currentGrants.includes(permission)) {
      return c.json({ success: false, message: 'Insufficient permissions' }, 403);
    }
    c.set('permissions', { has: (p: string) => currentGrants.includes(p) });
    return next();
  },
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import docTypesApp from './docTypes';

const ENV = {} as any;
const req = (path: string, init?: RequestInit) => docTypesApp.request(path, init, ENV);
const json = (method: string, body: any) => ({
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.clearAllMocks();
  currentGrants = ['resource:read', 'resource:write'];
});

describe('GET / — employee doc_type leak (resource:write gate)', () => {
  const ROWS = {
    rows: [
      { doc_path: 'Training/Guide.pdf', doc_type: 'all' },
      { doc_path: 'HR/Handbook.pdf', doc_type: 'employee' },
      { doc_path: 'Reps/Pricebook.pdf', doc_type: 'rep' },
    ],
  };

  it('strips employee-typed paths entirely for a caller without resource:write (a plain rep)', async () => {
    currentGrants = ['resource:read'];
    mockExecQuery.mockResolvedValue(ROWS);
    const res = await req('/');
    const body: any = await res.json();
    expect(body.data).toEqual({ 'Training/Guide.pdf': 'all', 'Reps/Pricebook.pdf': 'rep' });
    expect(body.data['HR/Handbook.pdf']).toBeUndefined();
  });

  it('includes employee-typed paths for a caller holding resource:write (admin/employee)', async () => {
    mockExecQuery.mockResolvedValue(ROWS);
    const res = await req('/');
    const body: any = await res.json();
    expect(body.data).toEqual({
      'Training/Guide.pdf': 'all',
      'HR/Handbook.pdf': 'employee',
      'Reps/Pricebook.pdf': 'rep',
    });
  });

  it('403s without resource:read at all', async () => {
    currentGrants = [];
    const res = await req('/');
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('PUT / — resource document mirror sync', () => {
  it('upserts document_type and the mirrored public.document row', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/', json('PUT', { path: 'Training/Guide.pdf', type: 'rep', fileSize: 1234, mimeType: 'application/pdf' }));
    expect(res.status).toBe(200);
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV, expect.stringContaining('INSERT INTO public.document_type'), ['Training/Guide.pdf', 'rep'], 'docTypes.upsert'
    );
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining("INSERT INTO public.document"),
      ['Training/Guide.pdf', 'Guide.pdf', 'application/pdf', 1234],
      'docTypes.upsertResourceDocument'
    );
  });

  it('400s an invalid type before writing anything', async () => {
    const res = await req('/', json('PUT', { path: 'x.pdf', type: 'bogus' }));
    expect(res.status).toBe(400);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('a type-only change (no re-upload) omits fileSize/mimeType — the mirror row preserves its existing values via COALESCE', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/', json('PUT', { path: 'Training/Guide.pdf', type: 'employee' }));
    expect(res.status).toBe(200);
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining('COALESCE(EXCLUDED.mime_type'),
      ['Training/Guide.pdf', 'Guide.pdf', null, null],
      'docTypes.upsertResourceDocument'
    );
  });
});

describe('PATCH / — rename mirrors to both tables', () => {
  it('renames document_type and the mirrored document row', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/', json('PATCH', { fromPath: 'Old/a.pdf', toPath: 'New/a.pdf' }));
    expect(res.status).toBe(200);
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV, expect.stringContaining('UPDATE public.document_type'), ['Old/a.pdf', 'New/a.pdf'], 'docTypes.rename'
    );
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining("entity_type = 'resource'"),
      ['Old/a.pdf', 'New/a.pdf', 'a.pdf'],
      'docTypes.renameResourceDocument'
    );
  });
});

describe('DELETE / — removes both rows', () => {
  it('deletes document_type and the mirrored document row', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/', json('DELETE', { path: 'Old/a.pdf' }));
    expect(res.status).toBe(200);
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV, expect.stringContaining('DELETE FROM public.document_type'), ['Old/a.pdf'], 'docTypes.delete'
    );
    expect(mockExecQuery).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining("entity_type = 'resource'"),
      ['Old/a.pdf'],
      'docTypes.deleteResourceDocument'
    );
  });
});
