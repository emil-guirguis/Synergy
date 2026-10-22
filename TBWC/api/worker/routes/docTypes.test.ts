import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentGrants: string[] = ['resource:read', 'resource:write'];

// The send is stubbed — it would reach Supabase Storage and the mail edge fn.
// Hoisted along with a stand-in FileEmailError, since vi.mock's factory runs
// before module-level declarations and the route maps that error to a status.
const { mockEmailStoredFile, FileEmailError } = vi.hoisted(() => {
  class FileEmailError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
      this.name = 'FileEmailError';
    }
  }
  return { mockEmailStoredFile: vi.fn(), FileEmailError };
});
vi.mock('../fileEmail', () => ({
  emailStoredFile: (...a: any[]) => mockEmailStoredFile(...a),
  FileEmailError,
}));

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', { id: 'admin', email: 'admin@tbwc.test' });
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

const { mockListObjects, mockSignObjectUrl, mockSignUploadUrl, mockRemoveObjects, mockMoveObject } = vi.hoisted(() => ({
  mockListObjects: vi.fn(),
  mockSignObjectUrl: vi.fn(),
  mockSignUploadUrl: vi.fn(),
  mockRemoveObjects: vi.fn(),
  mockMoveObject: vi.fn(),
}));
vi.mock('../storageAdmin', () => ({
  listObjects: (...a: any[]) => mockListObjects(...a),
  signObjectUrl: (...a: any[]) => mockSignObjectUrl(...a),
  signUploadUrl: (...a: any[]) => mockSignUploadUrl(...a),
  removeObjects: (...a: any[]) => mockRemoveObjects(...a),
  moveObject: (...a: any[]) => mockMoveObject(...a),
  StorageAdminError: class StorageAdminError extends Error {
    constructor(message: string, public status = 500) {
      super(message);
    }
  },
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

describe('POST /email — send a resource as an attachment', () => {
  beforeEach(() => {
    mockEmailStoredFile.mockReset();
    mockEmailStoredFile.mockResolvedValue(['customer@example.com']);
  });

  it('sends the file from the rep-docs bucket and reports the recipients', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ mime_type: 'application/pdf' }] });
    const res = await req('/email', json('POST', { path: 'Reps/Pricebook.pdf', to: 'customer@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { sent: true, recipients: ['customer@example.com'] } });
    const [, file, input] = mockEmailStoredFile.mock.calls[0];
    expect(file).toEqual({
      bucket: 'rep-docs',
      path: 'Reps/Pricebook.pdf',
      fileName: 'Pricebook.pdf',
      mimeType: 'application/pdf',
    });
    // Reply-To is the authenticated caller, never anything from the body.
    expect(input.replyTo).toBe('admin@tbwc.test');
  });

  it('requires a path', async () => {
    const res = await req('/email', json('POST', { to: 'customer@example.com' }));
    expect(res.status).toBe(400);
    expect(mockEmailStoredFile).not.toHaveBeenCalled();
  });

  it('refuses a caller without resource:read', async () => {
    currentGrants = [];
    const res = await req('/email', json('POST', { path: 'Reps/Pricebook.pdf', to: 'c@example.com' }));
    expect(res.status).toBe(403);
    expect(mockEmailStoredFile).not.toHaveBeenCalled();
  });

  it('hides an employee-only file from a plain rep instead of emailing it', async () => {
    // Same rule as GET /: without resource:write an 'employee' file is invisible,
    // so it must not be emailable either.
    currentGrants = ['resource:read'];
    mockExecQuery.mockResolvedValue({ rows: [{ doc_path: 'HR/Handbook.pdf', doc_type: 'employee' }] });
    const res = await req('/email', json('POST', { path: 'HR/Handbook.pdf', to: 'c@example.com' }));
    expect(res.status).toBe(404);
    expect(mockEmailStoredFile).not.toHaveBeenCalled();
  });

  it('maps a FileEmailError to its own status', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    mockEmailStoredFile.mockRejectedValue(new FileEmailError('too big', 413));
    const res = await req('/email', json('POST', { path: 'Reps/Big.pdf', to: 'c@example.com' }));
    expect(res.status).toBe(413);
    expect((await res.json()) as any).toEqual({ success: false, message: 'too big' });
  });
});

describe('/storage/* — Resources bytes brokered by the Worker', () => {
  const TYPES = { rows: [{ doc_path: 'HR', doc_type: 'employee' }, { doc_path: 'Reps/Secret.pdf', doc_type: 'employee' }] };

  it('hides employee files AND everything under an employee folder from a read-only caller', async () => {
    currentGrants = ['resource:read'];
    mockExecQuery.mockResolvedValue(TYPES);
    mockListObjects.mockResolvedValue([
      { name: 'Price.pdf', id: '1' },
      { name: 'Secret.pdf', id: '2' },
    ]);
    const res = await req('/storage/list', json('POST', { prefix: 'Reps' }));
    expect(((await res.json()) as any).data.map((e: any) => e.name)).toEqual(['Price.pdf']);

    mockListObjects.mockResolvedValue([{ name: 'HR', id: null }, { name: 'Training', id: null }]);
    const root = await req('/storage/list', json('POST', { prefix: '' }));
    expect(((await root.json()) as any).data.map((e: any) => e.name)).toEqual(['Training']);
  });

  it('shows everything to a resource:write holder', async () => {
    mockListObjects.mockResolvedValue([{ name: 'HR', id: null }]);
    const res = await req('/storage/list', json('POST', { prefix: '' }));
    expect(((await res.json()) as any).data).toHaveLength(1);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('refuses a view URL for a file inside an employee folder (inherited type)', async () => {
    currentGrants = ['resource:read'];
    mockExecQuery.mockResolvedValue(TYPES);
    const res = await req('/storage/view-url', json('POST', { path: 'HR/Sub/Handbook.pdf' }));
    expect(res.status).toBe(404);
    expect(mockSignObjectUrl).not.toHaveBeenCalled();
  });

  it('signs a forced-download URL for a visible file', async () => {
    currentGrants = ['resource:read'];
    mockExecQuery.mockResolvedValue(TYPES);
    mockSignObjectUrl.mockResolvedValue('https://x.test/s?token=t');
    const res = await req('/storage/view-url', json('POST', { path: 'Reps/Price List.pdf', download: true }));
    expect(((await res.json()) as any).data.url).toBe('https://x.test/s?token=t&download=Price%20List.pdf');
  });

  it.each(['upload-url', 'remove'])('403s %s without resource:write', async (route) => {
    currentGrants = ['resource:read'];
    const res = await req(`/storage/${route}`, json('POST', { path: 'Reps/x.pdf' }));
    expect(res.status).toBe(403);
  });

  it('upload URL is signed with upsert (re-upload replaces)', async () => {
    mockSignUploadUrl.mockResolvedValue('u');
    await req('/storage/upload-url', json('POST', { path: 'Reps/x.pdf' }));
    expect(mockSignUploadUrl).toHaveBeenCalledWith(ENV, 'rep-docs', 'Reps/x.pdf', true);
  });

  it('400s traversal paths', async () => {
    const res = await req('/storage/move', json('POST', { fromPath: 'Reps/x.pdf', toPath: '../record-docs/x.pdf' }));
    expect(res.status).toBe(400);
    expect(mockMoveObject).not.toHaveBeenCalled();
  });
});
