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

vi.mock('../crud', () => ({
  findAll: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../errorHandler', () => ({
  logError: vi.fn(),
}));

import { verify } from 'hono/jwt';
import { query } from '../db';
import { clearUserCache, clearPermissionCache } from '../middleware';
import { findAll, findById, create, update, remove } from '../crud';
import templatesApp from './templates';
import type { Env } from '../db';
import { authQuery, queueAuth } from '../testAuth';

const mockVerify = vi.mocked(verify);
const mockQuery = vi.mocked(query);
const mockFindAll = vi.mocked(findAll);
const mockFindById = vi.mocked(findById);
const mockCreate = vi.mocked(create);
const mockUpdate = vi.mocked(update);
const mockRemove = vi.mocked(remove);

const TEST_ENV: Env = {
  JWT_SECRET: 'test-secret',
  HYPERDRIVE: { connectionString: 'postgresql://test:test@localhost/test' },
};

const ADMIN_USER = {
  users_id: 1, name: 'Admin', email: 'admin@test.com',
  role: 'admin', active: true, tenant_id: 1, permissions: {},
};

function setupAuth() {
  mockVerify.mockResolvedValue({ userId: 1, tenant_id: 1 });
  mockQuery.mockImplementation(authQuery(ADMIN_USER));
}

describe('Templates Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUserCache();
    clearPermissionCache();
    setupAuth();
  });

  describe('GET /', () => {
    it('returns paginated list of templates', async () => {
      mockFindAll.mockResolvedValueOnce({
        rows: [
          { email_template_id: 1, name: 'Welcome Email', subject: 'Welcome!', category: 'general', isactive: true },
          { email_template_id: 2, name: 'Alert Email', subject: 'Alert!', category: 'meter_readings', isactive: true },
        ],
        pagination: { total: 2, page: 1, pageSize: 25, totalPages: 1 },
      });

      const res = await templatesApp.request('/', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });

    it('returns 401 when not authenticated', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Invalid token'));

      const res = await templatesApp.request('/', {
        headers: { authorization: 'Bearer bad-token' },
      }, TEST_ENV);

      expect(res.status).toBe(401);
    });
  });

  describe('GET /categories', () => {
    it('returns list of valid categories', async () => {
      const res = await templatesApp.request('/categories', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toContainEqual(expect.objectContaining({ value: 'general' }));
      expect(body.data).toContainEqual(expect.objectContaining({ value: 'meter_readings' }));
    });
  });

  describe('GET /stats', () => {
    it('returns template statistics', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [{ total: '10', active: '8', inactive: '2', categories: '3' }],
        } as any);

      const res = await templatesApp.request('/stats', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.total).toBe('10');
    });
  });

  describe('GET /:id', () => {
    it('returns a single template', async () => {
      mockFindById.mockResolvedValueOnce({
        email_template_id: 1, name: 'Welcome Email', subject: 'Welcome!',
        content: '<p>Hello</p>', category: 'general', isactive: true, tenant_id: 1,
      });

      const res = await templatesApp.request('/1', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.email_template_id).toBe(1);
      expect(body.data.name).toBe('Welcome Email');
    });

    it('returns 404 when template not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await templatesApp.request('/999', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Template not found');
    });
  });

  describe('GET /:id/variables', () => {
    it('returns template variables', async () => {
      mockFindById.mockResolvedValueOnce({
        email_template_id: 1, name: 'Alert', variables: ['meter_name', 'reading_value'], tenant_id: 1,
      });

      const res = await templatesApp.request('/1/variables', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.variables).toHaveLength(2);
      expect(body.data.totalVariables).toBe(2);
    });

    it('returns 404 when template not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await templatesApp.request('/999/variables', {
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /', () => {
    it('creates a template', async () => {
      mockCreate.mockResolvedValueOnce({
        email_template_id: 10, name: 'New Template', subject: 'Hello',
        content: '<p>Content</p>', category: 'general', tenant_id: 1,
      });

      const res = await templatesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'New Template',
          subject: 'Hello',
          content: '<p>Content</p>',
          category: 'general',
        }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.email_template_id).toBe(10);
    });

    it('returns 400 when name is too short', async () => {
      const res = await templatesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'AB', subject: 'Hello', content: 'Hi', category: 'general' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('3 characters');
    });

    it('returns 400 when subject is missing', async () => {
      const res = await templatesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Valid Name', content: 'Hi', category: 'general' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
      expect((await res.json()).message).toContain('Subject');
    });

    it('returns 400 for invalid category', async () => {
      const res = await templatesApp.request('/', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Valid Name', subject: 'Hi', content: 'Hi', category: 'invalid_cat' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /:id', () => {
    it('updates a template', async () => {
      mockFindById.mockResolvedValueOnce({ email_template_id: 1, name: 'Old', tenant_id: 1 });
      mockUpdate.mockResolvedValueOnce({ email_template_id: 1, name: 'Updated', tenant_id: 1 });

      const res = await templatesApp.request('/1', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated', subject: 'New Subject' }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('returns 404 when template not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await templatesApp.request('/999', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:id', () => {
    it('deletes a template', async () => {
      mockFindById.mockResolvedValueOnce({ email_template_id: 1, name: 'Test', tenant_id: 1 });
      mockRemove.mockResolvedValueOnce(undefined as any);

      const res = await templatesApp.request('/1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('returns 404 when template not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await templatesApp.request('/999', {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /validate', () => {
    it('returns 501 not implemented', async () => {
      const res = await templatesApp.request('/validate', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: '<p>test</p>' }),
      }, TEST_ENV);

      expect(res.status).toBe(501);
    });
  });

  describe('POST /:id/duplicate', () => {
    it('duplicates a template', async () => {
      mockFindById.mockResolvedValueOnce({
        email_template_id: 1, name: 'Original', subject: 'Hi',
        content: '<p>Hi</p>', category: 'general', variables: [], tenant_id: 1,
      });
      mockCreate.mockResolvedValueOnce({
        email_template_id: 20, name: 'Copy of Original', subject: 'Hi',
        content: '<p>Hi</p>', category: 'general', tenant_id: 1,
      });

      const res = await templatesApp.request('/1/duplicate', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Copy of Original' }),
      }, TEST_ENV);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.email_template_id).toBe(20);
    });

    it('returns 400 when name is too short', async () => {
      const res = await templatesApp.request('/1/duplicate', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'AB' }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('returns 404 when original template not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const res = await templatesApp.request('/999/duplicate', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'New Copy' }),
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /:id/usage', () => {
    it('records template usage and returns updated counts', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({
          rows: [{ email_template_id: 1, usagecount: 5, lastused: new Date() }],
        } as any);

      const res = await templatesApp.request('/1/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.usagecount).toBe(5);
    });

    it('returns 404 when template not found', async () => {
      queueAuth(mockQuery, ADMIN_USER)
        .mockResolvedValueOnce({ rows: [] } as any);

      const res = await templatesApp.request('/999/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }, TEST_ENV);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /bulk', () => {
    it('activates multiple templates', async () => {
      mockUpdate
        .mockResolvedValueOnce({ email_template_id: 1, isactive: true } as any)
        .mockResolvedValueOnce({ email_template_id: 2, isactive: true } as any);

      const res = await templatesApp.request('/bulk', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'activate', templateIds: [1, 2] }),
      }, TEST_ENV);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.updated).toBe(2);
    });

    it('returns 400 for invalid bulk action', async () => {
      const res = await templatesApp.request('/bulk', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'invalid', templateIds: [1] }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });

    it('returns 400 when templateIds is empty', async () => {
      const res = await templatesApp.request('/bulk', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'activate', templateIds: [] }),
      }, TEST_ENV);

      expect(res.status).toBe(400);
    });
  });
});
