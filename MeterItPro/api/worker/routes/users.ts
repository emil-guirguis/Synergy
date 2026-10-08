/**
 * Users CRUD routes - Hono worker
 */

import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { sign } from 'hono/jwt';
import { Env, execQuery } from '../db';
import { canImpersonate } from '@meterit/framework-backend/api/base/auth';

import { authenticateToken, requirePermission, clearUserCache, AuthVariables } from '../middleware';
import { findAll, findById, create, update, remove, checkDeleteRestrictions, whereFromQuery, likeFieldsFromSchema, fieldMapFromSchema } from '../crud';
import { userSchema } from './usersSchema';

// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues — 'role' is an enum select, so it's exact-match).
const LIKE_FIELDS = likeFieldsFromSchema(userSchema);
const FIELD_MAP = fieldMapFromSchema(userSchema);
import { logError } from '../errorHandler';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// All routes require authentication
app.use('*', authenticateToken);

// --- Inline permissions helpers (replaces PermissionsService) ---

const ROLE_PERMISSIONS: Record<string, Record<string, Record<string, boolean>>> = {
  admin: {
    user: { create: true, read: true, update: true, delete: true },
    meter: { create: true, read: true, update: true, delete: true },
    device: { create: true, read: true, update: true, delete: true },
    location: { create: true, read: true, update: true, delete: true },
    contact: { create: true, read: true, update: true, delete: true },
    template: { create: true, read: true, update: true, delete: true },
    settings: { read: true, update: true },
    building: { create: true, read: true, update: true, delete: true },
    equipment: { create: true, read: true, update: true, delete: true },
  },
  Manager: {
    user: { read: true, update: true },
    meter: { create: true, read: true, update: true, delete: true },
    device: { create: true, read: true, update: true, delete: true },
    location: { create: true, read: true, update: true, delete: true },
    contact: { create: true, read: true, update: true, delete: true },
    template: { create: true, read: true, update: true },
    settings: { read: true },
    building: { create: true, read: true, update: true, delete: true },
    equipment: { create: true, read: true, update: true, delete: true },
  },
  Technician: {
    meter: { read: true, update: true },
    device: { read: true, update: true },
    location: { read: true },
    contact: { read: true },
    template: { read: true },
    building: { read: true },
    equipment: { read: true, update: true },
  },
  Viewer: {
    meter: { read: true },
    device: { read: true },
    location: { read: true },
    contact: { read: true },
    template: { read: true },
    settings: { read: true },
    building: { read: true },
    equipment: { read: true },
  },
};

function getPermissionsByRole(role: string): Record<string, Record<string, boolean>> {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS['Viewer'];
}

function validatePermissionsObject(perms: any): boolean {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return false;
  for (const module of Object.keys(perms)) {
    if (typeof perms[module] !== 'object' || Array.isArray(perms[module])) return false;
    for (const action of Object.keys(perms[module])) {
      if (typeof perms[module][action] !== 'boolean') return false;
    }
  }
  return true;
}

function toNestedObject(flatArray: string[]): Record<string, Record<string, boolean>> {
  const result: Record<string, Record<string, boolean>> = {};
  for (const perm of flatArray) {
    const [module, action] = perm.split(':');
    if (module && action) {
      if (!result[module]) result[module] = {};
      result[module][action] = true;
    }
  }
  return result;
}

// --- Routes ---

// Get all users with filtering and pagination
app.get('/', requirePermission('user:read'), async (c) => {
  try {
    const qs = c.req.query();
    const tenantId = c.get('tenantId');

    const { where, whereLike } = whereFromQuery(qs, { likeFields: LIKE_FIELDS, fieldMap: FIELD_MAP });

    const result = await findAll(c.env, {
      table: 'users',
      primaryKey: 'users_id',
      tenantId,
      page: parseInt(qs.page || '1', 10),
      limit: parseInt(qs.limit || '25', 10),
      search: qs.search || undefined,
      searchFields: ['name', 'email'],
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
    logError('Error fetching users:', error);
    return c.json({ success: false, message: 'Failed to fetch users' }, 500);
  }
});

// Get single user by ID
app.get('/:id', requirePermission('user:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const user = await findById(c.env, 'users', 'users_id', id, tenantId);
    if (!user) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }
    return c.json({ success: true, data: user });
  } catch (error: any) {
    logError('Error fetching user:', error);
    return c.json({ success: false, message: 'Failed to fetch user' }, 500);
  }
});

// Create user
app.post('/', requirePermission('user:create'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({
        success: false,
        message: 'User must have a valid tenant_id to create users',
      }, 400);
    }

    const body = await c.req.json();
    const userData: Record<string, any> = {
      ...body,
      tenant_id: tenantId,
    };

    if (!userData.password) {
      return c.json({ success: false, message: 'Password is required' }, 400);
    }

    const salt = await bcrypt.genSalt(10);
    userData.passwordhash = await bcrypt.hash(userData.password, salt);
    delete userData.password;

    // Auto-generate permissions based on role if not explicitly provided
    if (!userData.permissions || (Array.isArray(userData.permissions) && userData.permissions.length === 0)) {
      const role = userData.role || 'Viewer';
      const permissionsObj = getPermissionsByRole(role);
      if (!validatePermissionsObject(permissionsObj)) {
        return c.json({
          success: false,
          message: 'Failed to generate valid permissions for role',
        }, 500);
      }
      userData.permissions = JSON.stringify(permissionsObj);
    } else if (typeof userData.permissions === 'object' && !Array.isArray(userData.permissions)) {
      if (!validatePermissionsObject(userData.permissions)) {
        return c.json({
          success: false,
          message: 'Invalid permissions object structure',
        }, 400);
      }
      userData.permissions = JSON.stringify(userData.permissions);
    }

    const user = await create(c.env, 'users', userData);
    return c.json({ success: true, data: user }, 201);
  } catch (error: any) {
    logError('Error creating user:', error);
    return c.json({
      success: false,
      message: 'Failed to create user',
      error: error.message,
      detail: error.detail,
      code: error.code,
    }, 500);
  }
});

// Update user
app.put('/:id', requirePermission('user:update'), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');

    // Find the user first (findById already filters by tenantId)
    const user = await findById(c.env, 'users', 'users_id', id, tenantId);
    if (!user) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }

    const body = await c.req.json();
    const updateData: Record<string, any> = { ...body };

    // The Preferences tab's '(system default)' selects post '' when cleared;
    // the matching column needs null, not ''.
    if (updateData.timezone === '') updateData.timezone = null;
    if (updateData.date_format === '') updateData.date_format = null;
    if (updateData.time_format === '') updateData.time_format = null;
    if (updateData.default_page_size === '' || updateData.default_page_size === null) {
      updateData.default_page_size = null;
    } else if (updateData.default_page_size !== undefined) {
      updateData.default_page_size = Number(updateData.default_page_size);
    }

    // Remove protected/read-only fields
    delete updateData.password;
    delete updateData.tenant_id;
    delete updateData.tenantId;
    delete updateData.password_reset_token;
    delete updateData.password_reset_expires_at;
    delete updateData.passwordHash;
    delete updateData.passwordhash;
    delete updateData.createdAt;
    delete updateData.created_at;
    delete updateData.updatedAt;
    delete updateData.updated_at;
    delete updateData.lastLogin;
    delete updateData.last_login_at;
    delete updateData.passwordChangedAt;
    delete updateData.failedLoginAttempts;
    delete updateData.failed_login_attempts;
    delete updateData.lockedUntil;
    delete updateData.locked_until;

    // Handle permissions serialization
    if (updateData.permissions !== undefined && updateData.permissions !== null) {
      if (typeof updateData.permissions === 'object' && !Array.isArray(updateData.permissions)) {
        if (Object.keys(updateData.permissions).length === 0) {
          delete updateData.permissions;
        } else if (!validatePermissionsObject(updateData.permissions)) {
          return c.json({ success: false, message: 'Invalid permissions object structure' }, 400);
        } else {
          updateData.permissions = JSON.stringify(updateData.permissions);
        }
      } else if (Array.isArray(updateData.permissions)) {
        if (updateData.permissions.length === 0) {
          delete updateData.permissions;
        } else {
          const nestedObj = toNestedObject(updateData.permissions);
          if (!validatePermissionsObject(nestedObj)) {
            return c.json({ success: false, message: 'Invalid permissions array format' }, 400);
          }
          updateData.permissions = JSON.stringify(nestedObj);
        }
      } else if (typeof updateData.permissions === 'string') {
        try {
          const parsed = JSON.parse(updateData.permissions);
          if (Array.isArray(parsed)) {
            const nestedObj = toNestedObject(parsed);
            if (!validatePermissionsObject(nestedObj)) {
              return c.json({ success: false, message: 'Invalid permissions array format' }, 400);
            }
            updateData.permissions = JSON.stringify(nestedObj);
          } else if (!validatePermissionsObject(parsed)) {
            return c.json({ success: false, message: 'Invalid permissions JSON format' }, 400);
          }
        } catch (e) {
          return c.json({ success: false, message: 'Permissions must be valid JSON' }, 400);
        }
      }
    }

    const updated = await update(c.env, 'users', 'users_id', id, updateData);
    clearUserCache();
    return c.json({ success: true, data: updated });
  } catch (error: any) {
    logError('Error updating user:', error);
    return c.json({ success: false, message: 'Failed to update user' }, 500);
  }
});

// Change user password
app.put('/:id/password', requirePermission('user:update'), async (c) => {
  try {
    const userId = c.req.param('id');
    const { password, currentPassword } = await c.req.json();
    const currentUser = c.get('user');

    // Find the user
    const user = await findById(c.env, 'users', 'users_id', userId);
    if (!user) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }

    // If user is changing their own password, verify current password
    if (String(currentUser.users_id) === String(userId) && currentPassword) {
      const isCurrentValid = await bcrypt.compare(currentPassword, user.passwordhash);
      if (!isCurrentValid) {
        return c.json({ success: false, message: 'Current password is incorrect' }, 400);
      }
    }

    // Hash and update the new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    await execQuery(
      c.env,
      'UPDATE users SET passwordhash = $1, updated_at = NOW() WHERE users_id = $2',
      [passwordHash, userId]
    );

    return c.json({ success: true, message: 'Password updated successfully' });
  } catch (error: any) {
    logError('Error changing password:', error);
    return c.json({ success: false, message: 'Failed to change password' }, 500);
  }
});

// Admin reset user password
app.post('/:id/reset-password', requirePermission('user:update'), async (c) => {
  try {
    const userId = parseInt(c.req.param('id'), 10);
    const currentUser = c.get('user');
    const adminId = currentUser.users_id;

    if (!userId || isNaN(userId)) {
      return c.json({ success: false, message: 'Valid user ID is required' }, 400);
    }

    // Get target user
    const targetUser = await findById(c.env, 'users', 'users_id', userId);
    if (!targetUser) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }

    // Generate reset token (crypto.randomUUID available in Workers)
    const token = crypto.randomUUID();
    const tokenHash = await bcrypt.hash(token, await bcrypt.genSalt(10));
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Store token in database
    await execQuery(
      c.env,
      'UPDATE users SET password_reset_token = $1, password_reset_expires_at = $2, updated_at = NOW() WHERE users_id = $3',
      [tokenHash, expiresAt.toISOString(), userId]
    );

    // Log the admin password reset event
    try {
      await execQuery(
        c.env,
        'INSERT INTO auth_logs (user_id, event_type, status, details, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
        [userId, 'password_reset_admin', 'success', JSON.stringify({ admin_id: adminId, email: targetUser.email })]
      );
    } catch (error: any) {
      logError('[AUTH] Failed to log admin password reset', error);
    }

    return c.json({
      success: true,
      message: 'Password reset token has been generated for the user',
    });
  } catch (error: any) {
    logError('Admin reset password error:', error);
    return c.json({
      success: false,
      message: 'Failed to process admin password reset',
    }, 500);
  }
});

// Delete user
app.delete('/:id', requirePermission('user:delete'), async (c) => {
  try {
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');

    const user = await findById(c.env, 'users', 'users_id', id, tenantId);
    if (!user) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }

    const violation = await checkDeleteRestrictions(c.env, userSchema, id);
    if (violation) return c.json({ success: false, message: violation.message }, 409);

    await remove(c.env, 'users', 'users_id', id, tenantId);
    return c.json({ success: true, message: 'User deleted successfully' });
  } catch (error: any) {
    logError('Error deleting user:', error);
    return c.json({ success: false, message: 'Failed to delete user' }, 500);
  }
});

// Dev-only "log in as this user" — mints a real JWT for the target (no
// password needed, straight sign() like the superadmin tenant-impersonation
// route in adminRoutes.ts). Unscoped by tenant deliberately: this is gated by
// canImpersonate's single-email check, not the normal tenant-role model, and
// the whole point is being able to test any user's account. Never reachable
// in prod since ENABLE_IMPERSONATION only ever lives in .dev.vars.
app.post('/:id/impersonate', requirePermission('user:read'), async (c) => {
  const caller = c.get('user');
  if (!canImpersonate(c.env, caller?.email)) {
    return c.json({ success: false, message: 'Not available' }, 403);
  }
  const targetId = parseInt(c.req.param('id'), 10);
  if (isNaN(targetId)) return c.json({ success: false, message: 'Invalid user id' }, 400);

  const result = await execQuery(c.env, 'SELECT users_id, email, tenant_id, name FROM users WHERE users_id = $1', [targetId]);
  const target = result.rows[0];
  if (!target) return c.json({ success: false, message: 'User not found' }, 404);

  const expiresIn = 3600;
  const token = await sign(
    { userId: target.users_id, tenant_id: target.tenant_id, exp: Math.floor(Date.now() / 1000) + expiresIn },
    c.env.JWT_SECRET
  );

  // Audit log, same table/style as the superadmin tenant-impersonation route.
  try {
    const ipAddress = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null;
    await execQuery(
      c.env,
      `INSERT INTO auth_logs (user_id, event_type, status, ip_address, details, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [caller.users_id, 'dev_impersonate_user', 'success', ipAddress, JSON.stringify({ target_user_id: target.users_id, target_email: target.email })]
    );
  } catch (logErr) {
    logError('Failed to write impersonation audit log', logErr);
  }

  return c.json({
    success: true,
    data: { token, refreshToken: '', expiresIn, user: { users_id: target.users_id, email: target.email, name: target.name } },
  });
});

export default app;
