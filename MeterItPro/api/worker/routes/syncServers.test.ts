import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    execQuery: vi.fn((env: any, sql: string, params?: any[]) => queryFn(env, sql, params)),
    transaction: vi.fn(),
  };
});

vi.mock('hono/jwt', () => ({
  verify: vi.fn(),
}));

vi.mock('../errorHandler', () => ({
  logError: vi.fn(),
}));

// Mock globalThis.fetch for Cloudflare API calls
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import syncServersApp from './syncServers';
import type { Env } from '../db';
import { authQuery, queueAuth } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);

const TEST_ENV: Env = {
  JWT_SECRET: 'test-secret',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@localhost/test' },
} as any;

const ADMIN_USER = {
  users_id: 1, name: 'Admin', email: 'admin@test.com',
  role: 'admin', active: true, tenant_id: 1, permissions: {},
};

function setupAuth() {
  mockVerify.mockResolvedValue({ userId: 1, tenant_id: 1 });
  mockQuery.mockImplementation(authQuery(ADMIN_USER));
}

describe('SyncServers Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
    mockFetch.mockReset();
  });

  describe('GET /', () => {
    it('returns list of sync servers for tenant', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [
            {
              sync_server_id: 1, tenant_id: 1, name: 'Server A',
              tunnel_url: 'https://a.meteritpro.com', timezone: 'UTC',
              active: true, notes: '', provision_status: 'active',
            },
          ],
        } as any);

      const res = await syncServersApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Server A');
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await syncServersApp.request('/', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('POST /', () => {
    it('creates a sync server', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any)           // check duplicate
        .mockResolvedValueOnce({
          rows: [{
            sync_server_id: 1, tenant_id: 1, name: 'New Server',
            tunnel_url: '', timezone: 'UTC', active: true, notes: '',
            bootstrap_key: 'some-uuid', tunnel_id: null,
            provision_status: 'pending', provision_error: null, dns_record_id: null,
            created_at: new Date(), updated_at: new Date(),
          }],
        } as any);

      const res = await syncServersApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Server', timezone: 'UTC' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('New Server');
      expect(body.data.provision_status).toBe('pending');
    });

    it('auto-generates a sync- name when name is missing', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any)           // auto-gen uniqueness check
        .mockImplementationOnce((_env: any, _sql: any, params: any = []) => Promise.resolve({
          rows: [{
            sync_server_id: 2, tenant_id: 1, name: params[2],
            tunnel_url: '', timezone: 'UTC', active: true, notes: '',
            bootstrap_key: 'some-uuid', tunnel_id: null,
            provision_status: 'pending', provision_error: null, dns_record_id: null,
            created_at: new Date(), updated_at: new Date(),
          }],
        }) as any);

      const res = await syncServersApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ timezone: 'UTC' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toMatch(/^sync-[0-9a-f]{6}$/);
    });

    it('returns 409 when server with same name exists', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] } as any); // existing server found

      const res = await syncServersApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Duplicate Server' }),
      }, TEST_ENV);

      expect(res.status).toBe(409);
    });
  });

  describe('PUT /:id', () => {
    it('updates a sync server', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any)             // conflict check (no conflict)
        .mockResolvedValueOnce({
          rows: [{
            sync_server_id: 1, tenant_id: 1, name: 'Updated Server',
            tunnel_url: '', timezone: 'EST', active: true,
          }],
        } as any);

      const res = await syncServersApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated Server', timezone: 'EST' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Updated Server');
    });

    it('returns 200 with message when no fields to update', async () => {
      const res = await syncServersApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toContain('No fields');
    });

    it('returns 404 when server not found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any)             // conflict check (no conflict)
        .mockResolvedValueOnce({ rows: [] } as any);            // update returned nothing

      const res = await syncServersApp.request('/999', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Name' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:id', () => {
    it('deletes a sync server without tunnel', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ tunnel_id: null, dns_record_id: null }] } as any) // lookup
        .mockResolvedValueOnce({ rows: [] } as any); // delete

      const res = await syncServersApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('returns 404 when server not found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await syncServersApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('deletes CF tunnel before removing server record', async () => {
      const cfEnv = {
        ...TEST_ENV,
        CLOUDFLARE_ACCOUNT_ID: 'acct123',
        CLOUDFLARE_API_TOKEN: 'tok456',
      } as any;

      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ tunnel_id: 'tunnel-uuid', dns_record_id: 'dns-uuid' }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      // CF API: zones query, dns delete, tunnel delete
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: [{ id: 'zone1' }] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: {} }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: {} }) });

      clearUserCache();
    clearPermissionCache();
      mockVerify.mockResolvedValue({ userId: 1, tenant_id: 1 });
      queueAuth(mockQuery, ADMIN_USER);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ tunnel_id: 'tunnel-uuid', dns_record_id: 'dns-uuid' }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await syncServersApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, cfEnv);

      expect(res.status).toBe(200);
    });
  });

  describe('POST /:id/test-connection', () => {
    it('returns success when server health check passes', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ tunnel_url: 'https://server.example.com' }] } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', version: '1.0' }),
      });

      const res = await syncServersApp.request('/1/test-connection', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('Connected');
    });

    it('returns 404 when server not found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await syncServersApp.request('/999/test-connection', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });

    it('returns failure when health check fails', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [{ tunnel_url: 'https://server.example.com' }] } as any);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const res = await syncServersApp.request('/1/test-connection', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('503');
    });
  });

  describe('GET /:id/bootstrap', () => {
    it('returns tunnel token when provision status is active', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          provision_status: 'active',
          provision_error: null,
          tunnel_token: 'secret-token',
        }],
      } as any);

      const res = await syncServersApp.request('/1/bootstrap?key=bootstrap-key-123', {}, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.provision_status).toBe('active');
      expect(body.data.tunnel_token).toBe('secret-token');
    });

    it('returns null tunnel_token when not yet active', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          provision_status: 'pending',
          provision_error: null,
          tunnel_token: 'secret-token',
        }],
      } as any);

      const res = await syncServersApp.request('/1/bootstrap?key=bootstrap-key', {}, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.tunnel_token).toBeNull();
    });

    it('returns 400 when key is missing', async () => {
      const res = await syncServersApp.request('/1/bootstrap', {}, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('returns 404 when bootstrap key does not match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      const res = await syncServersApp.request('/1/bootstrap?key=wrong-key', {}, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });
});
