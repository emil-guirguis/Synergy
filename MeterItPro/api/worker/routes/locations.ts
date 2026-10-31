/**
 * Locations CRUD routes - Hono worker
 */

import { Hono } from 'hono';
import { Env, execQuery } from '../db';

import { authenticateToken, requirePermission, AuthVariables } from '../middleware';
import { findAll, findById, create, update, remove, checkDeleteRestrictions, whereFromQuery, likeFieldsFromSchema, fieldMapFromSchema } from '../crud';
import { locationSchema } from './locationSchema';

// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — 'type' is an enum select, so it's exact-match).
const LIKE_FIELDS = likeFieldsFromSchema(locationSchema);
const FIELD_MAP = fieldMapFromSchema(locationSchema);
import { logError } from '../errorHandler';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// All routes require authentication
app.use('*', authenticateToken);

// --- Routes ---

// Get all locations with filtering and pagination
app.get('/', requirePermission('location:read'), async (c) => {
  try {
    const qs = c.req.query();
    const tenantId = c.get('tenantId');


    if (!tenantId) {
      console.error('[LOCATION] No tenantId in context');
      return c.json({ success: false, message: 'Tenant context required' }, 401);
    }

    const { where, whereLike } = whereFromQuery(qs, { likeFields: LIKE_FIELDS, fieldMap: FIELD_MAP });

    const result = await findAll(c.env, {
      table: 'location',
      primaryKey: 'location_id',
      tenantId,
      page: parseInt(qs.page || '1', 10),
      limit: parseInt(qs.limit || '25', 10),
      search: qs.search || undefined,
      searchFields: ['name'],
      sortBy: qs.sortBy,
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
    logError('Error fetching locations', error);
    return c.json({ 
      success: false, 
      message: 'Failed to fetch locations',
      ...(process.env.NODE_ENV !== 'production' && { detail: error?.message })
    }, 500);
  }
});

// Get single location by ID
app.get('/:id', requirePermission('location:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const location = await findById(c.env, 'location', 'location_id', id, tenantId);
    if (!location) {
      return c.json({ success: false, message: 'Location not found' }, 404);
    }
    return c.json({ success: true, data: location });
  } catch (error: any) {
    logError('Error fetching location:', error);
    return c.json({ success: false, message: 'Failed to fetch location' }, 500);
  }
});

// Create location
app.post('/', requirePermission('location:create'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({
        success: false,
        message: 'User must have a valid tenant_id to create locations',
      }, 400);
    }

    const body = await c.req.json();
    const locationData: Record<string, any> = {
      ...body,
      tenant_id: tenantId,
    };

    const location = await create(c.env, 'location', locationData);
    return c.json({ success: true, data: location }, 201);
  } catch (error: any) {
    logError('Error creating location:', error);
    return c.json({ success: false, message: 'Failed to create location' }, 500);
  }
});

// Update location
app.put('/:id', requirePermission('location:update'), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');

    // Find the location first (findById already filters by tenantId)
    const location = await findById(c.env, 'location', 'location_id', id, tenantId);
    if (!location) {
      return c.json({ success: false, message: 'Location not found' }, 404);
    }

    const body = await c.req.json();
    const updateData: Record<string, any> = { ...body };

    // Remove tenant_id from update data - it cannot be changed
    delete updateData.tenant_id;
    delete updateData.tenantId;

    const updated = await update(c.env, 'location', 'location_id', id, updateData);
    return c.json({ success: true, data: updated });
  } catch (error: any) {
    logError('Error updating location:', error);
    return c.json({ success: false, message: 'Failed to update location' }, 500);
  }
});

// Delete location
app.delete('/:id', requirePermission('location:delete'), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');

    // Find the location first
    const location = await findById(c.env, 'location', 'location_id', id, tenantId);
    if (!location) {
      return c.json({ success: false, message: 'Location not found' }, 404);
    }

    // Schema-declared delete restrictions (meters referencing this location)
    const violation = await checkDeleteRestrictions(c.env, locationSchema, id);
    if (violation) return c.json({ success: false, message: violation.message }, 409);

    await remove(c.env, 'location', 'location_id', id, tenantId);
    return c.json({ success: true, message: 'Location deleted successfully' });
  } catch (error: any) {
    logError('Error deleting location:', error);
    return c.json({ success: false, message: 'Failed to delete location' }, 500);
  }
});

export default app;
