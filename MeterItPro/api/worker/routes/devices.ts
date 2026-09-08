/**
 * Devices READ-ONLY routes - Hono worker
 *
 * NOTE: Device module is READ-ONLY.
 * CREATE, UPDATE, DELETE operations have been removed.
 * Devices are managed externally and should not be modified through this API.
 */

import { Hono } from 'hono';
import { Env, execQuery } from '../db';

import { authenticateToken, requirePermission, AuthVariables } from '../middleware';
import { findAll, findById, create, update, remove, whereFromQuery, likeFieldsFromSchema, fieldMapFromSchema } from '../crud';
import { deviceSchema } from './deviceSchema';

// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — 'manufacturer'/'type' are enum selects, so exact-match).
const LIKE_FIELDS = likeFieldsFromSchema(deviceSchema);
const FIELD_MAP = fieldMapFromSchema(deviceSchema);
import { logError } from '../errorHandler';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// All routes require authentication
app.use('*', authenticateToken);

// --- Routes ---

// Get all devices with filtering and pagination
app.get('/', requirePermission('device:read'), async (c) => {
  try {
    const qs = c.req.query();

    // Use defaultSortBy from schema if sortBy is not provided
    const sortBy = qs.sortBy || deviceSchema.defaultSortBy;

    const { where, whereLike } = whereFromQuery(qs, { likeFields: LIKE_FIELDS, fieldMap: FIELD_MAP });

    const result = await findAll(c.env, {
      table: 'device',
      primaryKey: 'device_id',
      page: parseInt(qs.page || '1', 10),
      limit: parseInt(qs.limit || '25', 10),
      search: qs.search || undefined,
      searchFields: ['description'],
      sortBy,
      sortOrder: qs.sortOrder,
      where,
      whereLike,
    });

    return c.json({
      success: true,
      data: {
        items: result.rows,
        total: result.pagination.total,
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
        totalPages: result.pagination.totalPages,
      },
    });
  } catch (error: any) {
    logError('Error fetching devices:', error);
    return c.json({ success: false, message: 'Failed to fetch devices' }, 500);
  }
});

// Get single device by ID
app.get('/:id', requirePermission('device:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const device = await findById(c.env, 'device', 'device_id', id, tenantId);
    if (!device) {
      return c.json({ success: false, message: 'Device not found' }, 404);
    }
    return c.json({ success: true, data: device });
  } catch (error: any) {
    logError('Error fetching device:', error);
    return c.json({ success: false, message: 'Failed to fetch device' }, 500);
  }
});

export default app;
