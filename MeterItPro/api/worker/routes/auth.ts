/**
 * Authentication routes for Cloudflare Worker (Hono)
 * Converted from Express auth-enhanced.js
 */

import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import { transaction, Env, execQuery } from '../db';

import { authenticateToken, getCachedUser, ipRateLimit, AuthVariables } from '../middleware';
import { logError } from '../errorHandler';

const auth = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ===== INLINE CONSTANTS =====

const ADMIN_PERMISSIONS = {
  user: { create: true, read: true, update: true, delete: true },
  meter: { create: true, read: true, update: true, delete: true },
  device: { create: true, read: true, update: true, delete: true },
  location: { create: true, read: true, update: true, delete: true },
  contact: { create: true, read: true, update: true, delete: true },
  template: { create: true, read: true, update: true, delete: true },
  settings: { read: true, update: true },
  building: { create: true, read: true, update: true, delete: true },
  equipment: { create: true, read: true, update: true, delete: true },
  dashboard: { create: true, read: true, update: true, delete: true, admin: true },
};

const SUPPORT_READ_PERMISSIONS = {
  user: { read: true },
  meter: { read: true },
  device: { read: true },
  location: { read: true },
  contact: { read: true },
  template: { read: true },
  settings: { read: true },
  building: { read: true },
  equipment: { read: true },
  dashboard: { read: true },
};

const ROLE_PERMISSIONS: Record<string, any> = {
  superadmin: ADMIN_PERMISSIONS,
  supersupport: SUPPORT_READ_PERMISSIONS,
  adminsupport: SUPPORT_READ_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  manager: {
    user: { read: true },
    meter: { create: true, read: true, update: true },
    device: { create: true, read: true, update: true },
    location: { create: true, read: true, update: true },
    contact: { create: true, read: true, update: true },
    template: { read: true },
    settings: { read: true },
    building: { create: true, read: true, update: true },
    equipment: { create: true, read: true, update: true },
    dashboard: { create: true, read: true, update: true, delete: true },
  },
  // Field role: owns the meters and everything hanging off them, reads the rest.
  // Must be listed explicitly — getPermissionsByRole() falls back to viewer for
  // any role missing here, which silently made technicians read-only.
  technician: {
    user: { read: true },
    meter: { create: true, read: true, update: true, delete: true },
    report: { create: true, read: true, update: true, delete: true },
    notification_rule: { create: true, read: true, update: true, delete: true },
    device: { read: true },
    location: { read: true },
    contact: { read: true },
    template: { read: true },
    settings: { read: true },
    building: { read: true },
    equipment: { read: true },
    dashboard: { read: true },
  },
  viewer: {
    meter: { read: true },
    device: { read: true },
    location: { read: true },
    contact: { read: true },
    template: { read: true },
    settings: { read: true },
    building: { read: true },
    equipment: { read: true },
    dashboard: { read: true },
  },
  user: {
    meter: { read: true },
    device: { read: true },
    location: { read: true },
    contact: { read: true },
    template: { read: true },
    settings: { read: true },
    building: { read: true },
    equipment: { read: true },
    dashboard: { read: true },
  },
};

function getPermissionsByRole(role: string): any {
  return ROLE_PERMISSIONS[role.toLowerCase()] || ROLE_PERMISSIONS.viewer;
}

// ===== TOKEN GENERATION UTILITIES =====

function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return 3600; // default 1h
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 3600;
  }
}

async function generateToken(userId: number, tenant_id: number, jwtSecret: string, expiresIn?: string): Promise<string> {
  const seconds = parseExpiresIn(expiresIn || '1h');
  return sign({ userId, tenant_id, exp: Math.floor(Date.now() / 1000) + seconds }, jwtSecret);
}

async function generateRefreshToken(userId: number, tenant_id: number, jwtSecret: string): Promise<string> {
  // Refresh tokens last 7 days
  return sign({ userId, tenant_id, isRefresh: true, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }, jwtSecret);
}

async function generate2FASessionToken(userId: number, tenant_id: number, jwtSecret: string): Promise<string> {
  return sign({ userId, tenant_id, is2FASession: true, exp: Math.floor(Date.now() / 1000) + 300 }, jwtSecret);
}

// ===== AUTH LOGGING (inline) =====

async function logAuthEvent(
  env: Env,
  params: {
    userId?: number;
    eventType: string;
    status: string;
    ipAddress?: string;
    userAgent?: string;
    details?: any;
  }
) {
  try {
    await execQuery(
      env,
      `INSERT INTO auth_logs (user_id, event_type, status, ip_address, user_agent, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        params.userId || null,
        params.eventType,
        params.status,
        params.ipAddress && /^[\d.:a-fA-F]+$/.test(params.ipAddress) ? params.ipAddress : null,
        params.userAgent || null,
        params.details ? JSON.stringify(params.details) : null,
      ]
    );
  } catch (error) {
    logError('[AUTH] Failed to log auth event:', error);
  }
}

// ===== RATE LIMITING / LOCKOUT UTILITIES =====

async function checkLoginLockout(env: Env, userId: number): Promise<{ isLocked: boolean; lockedUntil: string | null }> {
  try {
    const result = await execQuery(env, 'SELECT locked_until, failed_login_attempts FROM users WHERE users_id = $1', [userId]);
    if (result.rows.length === 0) {
      return { isLocked: false, lockedUntil: null };
    }
    const user = result.rows[0];
    const lockedUntil = user.locked_until;

    if (lockedUntil && new Date() < new Date(lockedUntil)) {
      return { isLocked: true, lockedUntil };
    }

    // Reset failed attempts if lockout has expired
    if (lockedUntil && new Date() >= new Date(lockedUntil)) {
      await execQuery(env, 'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE users_id = $1', [userId]);
    }

    return { isLocked: false, lockedUntil: null };
  } catch (error) {
    logError('Error checking login lockout:', error);
    return { isLocked: false, lockedUntil: null };
  }
}

async function incrementFailedLoginAttempts(
  env: Env,
  userId: number
): Promise<{ attempts: number; isLocked: boolean; lockedUntil: string | null }> {
  try {
    const result = await execQuery(env, 'SELECT failed_login_attempts FROM users WHERE users_id = $1', [userId]);
    if (result.rows.length === 0) {
      return { attempts: 0, isLocked: false, lockedUntil: null };
    }

    const newAttempts = (result.rows[0].failed_login_attempts || 0) + 1;
    let lockedUntil: string | null = null;

    if (newAttempts >= 5) {
      lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    }

    await execQuery(env, 'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE users_id = $3', [
      newAttempts,
      lockedUntil,
      userId,
    ]);

    return { attempts: newAttempts, isLocked: !!lockedUntil, lockedUntil };
  } catch (error) {
    logError('Error incrementing failed login attempts:', error);
    return { attempts: 0, isLocked: false, lockedUntil: null };
  }
}

async function resetFailedLoginAttempts(env: Env, userId: number): Promise<void> {
  try {
    await execQuery(
      env,
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE users_id = $1',
      [userId]
    );
  } catch (error) {
    logError('Error resetting failed login attempts:', error);
  }
}

async function get2FAMethods(env: Env, userId: number): Promise<string[]> {
  try {
    const result = await execQuery(
      env,
      `SELECT method_type FROM user_2fa_methods
       WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );
    return result.rows ? result.rows.map((row: any) => row.method_type) : [];
  } catch (error) {
    logError('Error getting 2FA methods:', error);
    return [];
  }
}

async function checkPasswordResetRateLimit(
  env: Env,
  email: string,
  maxRequests = 3,
  windowMs = 60 * 60 * 1000
): Promise<boolean> {
  try {
    const oneHourAgo = new Date(Date.now() - windowMs);
    const result = await execQuery(
      env,
      `SELECT COUNT(*) as count FROM auth_logs
       WHERE event_type = 'password_reset_requested'
       AND (details->>'email') = $1
       AND created_at > $2`,
      [email, oneHourAgo]
    );
    const count = parseInt(result.rows[0].count, 10);
    return count < maxRequests;
  } catch (error) {
    logError('Error checking rate limit:', error);
    return true;
  }
}

// ===== PASSWORD VALIDATION (inline) =====

function validatePassword(password: string, email?: string): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) {
    errors.push('Password must not contain your email username');
  }

  return { isValid: errors.length === 0, errors };
}

// ===== BACKUP CODE UTILITIES =====

function generateBackupCodes(count = 10): { code: string; hash?: string }[] {
  const codes: { code: string; hash?: string }[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomUUID().replace(/-/g, '').substring(0, 8).toUpperCase();
    codes.push({ code });
  }
  return codes;
}

async function storeBackupCodes(env: Env, userId: number, codes: { code: string }[]): Promise<void> {
  // Delete existing codes
  await execQuery(env, 'DELETE FROM user_2fa_backup_codes WHERE user_id = $1', [userId]);

  // Insert new codes
  for (const bc of codes) {
    const codeHash = await bcrypt.hash(bc.code, await bcrypt.genSalt(10));
    await execQuery(
      env,
      `INSERT INTO user_2fa_backup_codes (user_id, code_hash, is_used, created_at)
       VALUES ($1, $2, false, NOW())`,
      [userId, codeHash]
    );
  }
}

async function verifyBackupCode(env: Env, userId: number, code: string): Promise<boolean> {
  const result = await execQuery(
    env,
    `SELECT user_2fa_backup_codes_id, code_hash FROM user_2fa_backup_codes
     WHERE user_id = $1 AND is_used = false`,
    [userId]
  );

  for (const row of result.rows) {
    const matches = await bcrypt.compare(code, row.code_hash);
    if (matches) {
      // Mark as used
      await execQuery(
        env,
        'UPDATE user_2fa_backup_codes SET is_used = true WHERE user_2fa_backup_codes_id = $1',
        [row.user_2fa_backup_codes_id]
      );
      return true;
    }
  }
  return false;
}

// ===== TURNSTILE VERIFICATION =====

async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<{ ok: boolean; errorCodes: string[] }> {
  if (!env.TURNSTILE_SECRET) return { ok: true, errorCodes: [] };
  if (!token) return { ok: false, errorCodes: ['missing-input-response'] };
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const data: any = await res.json();
  console.log('[Turnstile] siteverify response:', JSON.stringify(data));
  return { ok: data.success === true, errorCodes: data['error-codes'] ?? [] };
}

// ===== PUBLIC ROUTES =====

/**
 * POST /signup
 * Create new tenant and admin user
 */
auth.post('/signup', ipRateLimit(5, 60 * 60 * 1000), async (c) => {
  try {
    const body = await c.req.json();
    const { company, user, payment, turnstileToken } = body;

    const tsResult = await verifyTurnstile(c.env, turnstileToken, c.req.header('cf-connecting-ip') || '');
    if (!tsResult.ok) {
      return c.json({ success: false, message: 'Bot verification failed. Please try again.', errorCodes: tsResult.errorCodes }, 400);
    }

    // Manual validation
    if (!user?.email || !user.email.includes('@')) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Valid email is required' }] }, 400);
    }
    if (!user?.password || user.password.length < 8) {
      return c.json(
        { success: false, message: 'Validation failed', errors: [{ msg: 'Password must be at least 8 characters' }] },
        400
      );
    }
    if (!user?.name || !user.name.trim()) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Name is required' }] }, 400);
    }
    if (!company?.name || !company.name.trim()) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Company name is required' }] }, 400);
    }

    try {
      const result = await transaction(c.env, async (client) => {
        // Generate an API key
        const apiKey = crypto.randomUUID();

        const tenantResult = await client.query(
          `INSERT INTO tenant (name, url, street, street2, city, state, zip, country, active, api_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING tenant_id`,
          [
            company.name,
            company.url || null,
            company.street || null,
            company.street2 || null,
            company.city || null,
            company.state || null,
            company.zip || null,
            company.country || 'US',
            true,
            apiKey,
          ]
        );

        const tenantId = tenantResult.rows[0].tenant_id;
        console.log('[SIGNUP] Created tenant:', tenantId);

        // Hash password
        const passwordHash = await bcrypt.hash(user.password, await bcrypt.genSalt(10));

        const permissionsValue = JSON.stringify(ADMIN_PERMISSIONS);

        const createUserResult = await client.query(
          `INSERT INTO users (email, name, passwordhash, role, permissions, active, tenant_id, phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING users_id, email, name, role, tenant_id`,
          [user.email, user.name, passwordHash, 'admin', permissionsValue, true, tenantId, user.phone || null]
        );

        const createdUserRow = createUserResult.rows[0];
        console.log('[SIGNUP] Created user (direct SQL):', createdUserRow.users_id);

        const createdUser = {
          id: createdUserRow.users_id,
          email: createdUserRow.email,
          name: createdUserRow.name,
          role: createdUserRow.role,
          tenant_id: createdUserRow.tenant_id,
        };

        return { tenantId, user: createdUser };
      });

      // Log payment information (for future processing)
      console.log('[SIGNUP] Payment method:', payment?.method);
      console.log('[SIGNUP] Plan type:', payment?.planType);

      return c.json({
        success: true,
        message: 'Account created successfully',
        data: {
          tenantId: result.tenantId,
          userId: result.user.id,
        },
      });
    } catch (err: any) {
      console.error('[SIGNUP] Transaction error:', err);

      if (err.message && err.message.includes('duplicate key')) {
        return c.json({ success: false, message: 'An account with this email already exists' }, 409);
      }

      return c.json({ success: false, message: 'Failed to create account' }, 500);
    }
  } catch (error: any) {
    logError('Signup error:', error);
    return c.json({ success: false, message: 'Signup failed' }, 500);
  }
});

/**
 * POST /login
 * Login with email and password, supporting 2FA
 */
auth.post('/login', ipRateLimit(10, 60 * 1000), async (c) => {
  try {
    const body = await c.req.json();
    const { email, password, turnstileToken } = body;

    console.log('[DEBUG] Login endpoint hit - email:', email);

    const tsResult = await verifyTurnstile(c.env, turnstileToken, c.req.header('cf-connecting-ip') || '');
    if (!tsResult.ok) {
      return c.json({ success: false, message: 'Bot verification failed. Please try again.', errorCodes: tsResult.errorCodes }, 400);
    }

    // Manual validation
    if (!email || !email.includes('@')) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Valid email is required' }] }, 400);
    }
    if (!password) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Password is required' }] }, 400);
    }

    const ipAddress = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined;
    const userAgent = c.req.header('user-agent') || '';

    // Find user by email
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);

    if (userResult.rows.length === 0) {
      await logAuthEvent(env(c), {
        eventType: 'login',
        status: 'failed',
        ipAddress,
        userAgent,
        details: { reason: 'user_not_found', email },
      });

      return c.json({ success: false, message: 'Invalid email or password' }, 401);
    }

    const user = userResult.rows[0];
    const userId = user.users_id;

    // Check if account is locked
    const lockoutStatus = await checkLoginLockout(env(c), userId);
    if (lockoutStatus.isLocked) {
      await logAuthEvent(env(c), {
        userId,
        eventType: 'login',
        status: 'failed',
        ipAddress,
        userAgent,
        details: { reason: 'account_locked', locked_until: lockoutStatus.lockedUntil },
      });

      return c.json({ success: false, message: 'Account is locked. Please try again later.' }, 401);
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordhash);

    if (!isPasswordValid) {
      const failureStatus = await incrementFailedLoginAttempts(env(c), userId);

      await logAuthEvent(env(c), {
        userId,
        eventType: 'login',
        status: 'failed',
        ipAddress,
        userAgent,
        details: {
          reason: 'invalid_password',
          attempts: failureStatus.attempts,
          is_locked: failureStatus.isLocked,
        },
      });

      return c.json({ success: false, message: 'Invalid email or password' }, 401);
    }

    // Check if user is active
    if (!user.active) {
      await logAuthEvent(env(c), {
        userId,
        eventType: 'login',
        status: 'failed',
        ipAddress,
        userAgent,
        details: { reason: 'user_inactive' },
      });

      return c.json({ success: false, message: 'Account is inactive' }, 401);
    }

    // Check if 2FA is enabled
    const twoFAMethods = await get2FAMethods(env(c), userId);

    if (twoFAMethods && twoFAMethods.length > 0) {
      const tempSessionToken = await generate2FASessionToken(userId, user.tenant_id, c.env.JWT_SECRET);

      await logAuthEvent(env(c), {
        userId,
        eventType: 'login',
        status: 'pending_2fa',
        ipAddress,
        userAgent,
        details: { reason: '2fa_required', methods: twoFAMethods },
      });

      return c.json({
        success: true,
        requires_2fa: true,
        session_token: tempSessionToken,
        available_methods: twoFAMethods,
        message: '2FA verification required',
      });
    }

    // No 2FA - create full session
    const token = await generateToken(userId, user.tenant_id, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN);
    const refreshToken = await generateRefreshToken(userId, user.tenant_id, c.env.JWT_SECRET);

    // Reset failed login attempts on successful login
    await resetFailedLoginAttempts(env(c), userId);

    // Log successful login
    await logAuthEvent(env(c), {
      userId,
      eventType: 'login',
      status: 'success',
      ipAddress,
      userAgent,
      details: { method: 'password' },
    });

    // Derive permissions from role
    const userRole = (user.role || 'viewer').toLowerCase();
    let permissions = getPermissionsByRole(userRole);

    if (user.permissions && typeof user.permissions === 'object' && !Array.isArray(user.permissions)) {
      permissions = user.permissions;
    }

    // Fetch tenant information
    let tenantInfo = null;
    if (user.tenant_id) {
      try {
        const tenantResult = await execQuery(
          env(c),
          'SELECT tenant_id, name, url, street, street2, city, state, zip, country, active, created_at, updated_at, api_key FROM tenant WHERE tenant_id = $1',
          [user.tenant_id]
        );
        if (tenantResult.rows && tenantResult.rows.length > 0) {
          tenantInfo = tenantResult.rows[0];
        }
      } catch (tenantErr) {
        console.error('Error fetching tenant info:', tenantErr);
      }
    }

    const responseData = {
      success: true,
      data: {
        user: {
          users_id: user.users_id,
          tenant_id: user.tenant_id,
          client: user.tenant_id,
          email: user.email,
          name: user.name,
          role: user.role,
          permissions,
          status: user.active ? 'active' : 'inactive',
          is_super_admin: user.is_super_admin || false,
          is_support_admin: user.is_support_admin || false,
        },
        tenant: tenantInfo,
        token,
        refreshToken,
        expiresIn: 60 * 60,
      },
    };

    console.log('[DEBUG] Sending response - user.active:', user.active, '-> status:', responseData.data.user.status);
    return c.json(responseData);
  } catch (error: any) {
    logError('[LOGIN] Unhandled error:', error);
    console.error('[LOGIN] Error type:', error?.constructor?.name);
    console.error('[LOGIN] Error message:', error?.message);
    console.error('[LOGIN] Error stack:', error?.stack);
    
    return c.json({ success: false, message: 'Login failed' }, 500);
  }
});

/**
 * POST /verify-2fa
 * Verify 2FA code and create full session
 */
auth.post('/verify-2fa', async (c) => {
  try {
    const body = await c.req.json();
    const { session_token, code, method } = body;

    // Manual validation
    if (!session_token) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Session token is required' }] }, 400);
    }
    if (!code) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: '2FA code is required' }] }, 400);
    }
    if (!['totp', 'email_otp', 'sms_otp', 'backup_code'].includes(method)) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Invalid 2FA method' }] }, 400);
    }

    const ipAddress = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined;
    const userAgent = c.req.header('user-agent') || '';

    // Verify session token
    let decoded: any;
    try {
      decoded = await verify(session_token, c.env.JWT_SECRET, 'HS256');
      if (!decoded.is2FASession) {
        return c.json({ success: false, message: 'Invalid session token' }, 401);
      }
    } catch (tokenError) {
      return c.json({ success: false, message: 'Session token expired or invalid' }, 401);
    }

    const userId = decoded.userId;
    const tenantId = decoded.tenant_id;

    // Get user
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE users_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }
    const user = userResult.rows[0];

    let isValid = false;
    const details: any = { method };

    // Verify 2FA code based on method
    if (method === 'totp') {
      const result = await execQuery(
        env(c),
        `SELECT secret_key FROM user_2fa_methods
         WHERE user_id = $1 AND method_type = 'totp' AND is_enabled = true`,
        [userId]
      );

      if (result.rows && result.rows.length > 0) {
        const secret = result.rows[0].secret_key;
        isValid = speakeasy.totp.verify({
          secret,
          encoding: 'base32',
          token: code,
          window: 1,
        });
      }
    } else if (method === 'backup_code') {
      isValid = await verifyBackupCode(env(c), userId, code);
    }
    // email_otp and sms_otp would need external service integration
    // For now they follow the same pattern but would need additional implementation

    if (!isValid) {
      await logAuthEvent(env(c), {
        userId,
        eventType: 'login',
        status: 'failed',
        ipAddress,
        userAgent,
        details: { reason: 'invalid_2fa_code', ...details },
      });

      return c.json(
        {
          success: false,
          message: 'Invalid 2FA code',
          details: {
            attempts_remaining: details.attempts_remaining,
            is_locked: details.is_locked,
          },
        },
        401
      );
    }

    // Create full session
    const token = await generateToken(userId, tenantId, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN);
    const refreshTokenValue = await generateRefreshToken(userId, tenantId, c.env.JWT_SECRET);

    // Reset failed login attempts
    await resetFailedLoginAttempts(env(c), userId);

    // Log successful login
    await logAuthEvent(env(c), {
      userId,
      eventType: 'login',
      status: 'success',
      ipAddress,
      userAgent,
      details: { method: '2fa', verification_method: method },
    });

    // Derive permissions from role
    const userRole = (user.role || 'viewer').toLowerCase();
    let permissions = getPermissionsByRole(userRole);

    if (user.permissions && typeof user.permissions === 'object' && !Array.isArray(user.permissions)) {
      permissions = user.permissions;
    }

    // Fetch tenant information
    let tenantInfo = null;
    if (tenantId) {
      try {
        const tenantResult = await execQuery(
          env(c),
          'SELECT tenant_id, name, url, street, street2, city, state, zip, country, active, created_at, updated_at FROM tenant WHERE tenant_id = $1',
          [tenantId]
        );
        if (tenantResult.rows && tenantResult.rows.length > 0) {
          tenantInfo = tenantResult.rows[0];
        }
      } catch (tenantErr) {
        console.error('Error fetching tenant info:', tenantErr);
      }
    }

    return c.json({
      success: true,
      data: {
        user: {
          users_id: user.users_id,
          tenant_id: user.tenant_id,
          client: user.tenant_id,
          email: user.email,
          name: user.name,
          role: user.role,
          permissions,
          status: user.active ? 'active' : 'inactive',
          is_super_admin: user.is_super_admin || false,
          is_support_admin: user.is_support_admin || false,
        },
        tenant: tenantInfo,
        token,
        refreshToken: refreshTokenValue,
        expiresIn: 60 * 60,
      },
    });
  } catch (error: any) {
    logError('2FA verification error:', error);
    return c.json({ success: false, message: '2FA verification failed' }, 500);
  }
});

/**
 * POST /forgot-password
 * Request password reset link (self-service)
 */
auth.post('/forgot-password', async (c) => {
  try {
    const body = await c.req.json();
    const { email, turnstileToken } = body;

    const tsResult = await verifyTurnstile(c.env, turnstileToken, c.req.header('cf-connecting-ip') || '');
    if (!tsResult.ok) {
      return c.json({ success: false, message: 'Bot verification failed. Please try again.', errorCodes: tsResult.errorCodes }, 400);
    }

    // Manual validation
    if (!email || !email.includes('@')) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Valid email is required' }] }, 400);
    }

    // Check rate limit (3 per hour per email)
    const isUnderLimit = await checkPasswordResetRateLimit(env(c), email, 3, 60 * 60 * 1000);
    if (!isUnderLimit) {
      // Don't reveal rate limit to user for security
      return c.json({
        success: true,
        message: 'If an account exists with this email, you will receive a password reset link',
      });
    }

    // Find user by email
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];

      // Generate reset token
      const resetToken = crypto.randomUUID();
      const tokenHash = await bcrypt.hash(resetToken, await bcrypt.genSalt(10));
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Store token in database
      await execQuery(
        env(c),
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, is_used, created_at)
         VALUES ($1, $2, $3, false, NOW())`,
        [user.users_id, tokenHash, expiresAt]
      );

      // Build reset link (email sending would need a separate service in Workers)
      const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:3000';
      const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;
      console.log('[AUTH] Password reset link generated for:', email, '- Link:', resetLink);

      // Log the request
      try {
        await logAuthEvent(env(c), {
          userId: user.users_id,
          eventType: 'password_reset_requested',
          status: 'success',
          details: { email },
        });
      } catch (error: any) {
        logError('[AUTH] Failed to log password reset request', error);
      }
    }

    // Always return generic message for security
    return c.json({
      success: true,
      message: 'If an account exists with this email, you will receive a password reset link',
    });
  } catch (error: any) {
    logError('Forgot password error:', error);
    return c.json({ success: false, message: 'Failed to process password reset request' }, 500);
  }
});

/**
 * POST /reset-password
 * Reset password using reset token
 */
auth.post('/reset-password', async (c) => {
  try {
    const body = await c.req.json();
    const { token, newPassword, confirmPassword, turnstileToken } = body;

    const tsResult = await verifyTurnstile(c.env, turnstileToken, c.req.header('cf-connecting-ip') || '');
    if (!tsResult.ok) {
      return c.json({ success: false, message: 'Bot verification failed. Please try again.', errorCodes: tsResult.errorCodes }, 400);
    }

    // Manual validation
    if (!token) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Reset token is required' }] }, 400);
    }
    if (!newPassword) {
      return c.json(
        { success: false, message: 'Validation failed', errors: [{ msg: 'New password is required' }] },
        400
      );
    }
    if (!confirmPassword) {
      return c.json(
        { success: false, message: 'Validation failed', errors: [{ msg: 'Password confirmation is required' }] },
        400
      );
    }

    // Verify passwords match
    if (newPassword !== confirmPassword) {
      return c.json({ success: false, message: 'Passwords do not match' }, 400);
    }

    // Find the matching token by comparing submitted token against all valid hashes.
    // We cannot query by hash directly (bcrypt is one-way), so we fetch all valid
    // unused tokens and compare each — there should never be many at any given time.
    const tokenResult = await execQuery(
      env(c),
      `SELECT user_id, token_hash, expires_at
       FROM password_reset_tokens
       WHERE expires_at > CURRENT_TIMESTAMP
       AND is_used = false`
    );

    if (!tokenResult.rows || tokenResult.rows.length === 0) {
      return c.json({ success: false, message: 'Reset link has expired or is invalid' }, 400);
    }

    let matchedUserId: number | null = null;
    for (const row of tokenResult.rows) {
      const matches = await bcrypt.compare(token, row.token_hash);
      if (matches) {
        matchedUserId = row.user_id;
        break;
      }
    }

    if (!matchedUserId) {
      await logAuthEvent(env(c), {
        eventType: 'password_reset',
        status: 'failed',
        details: { reason: 'invalid_token' },
      });

      return c.json({ success: false, message: 'Reset link has expired or is invalid' }, 400);
    }

    const userId = matchedUserId;

    // Get user
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE users_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }
    const user = userResult.rows[0];

    // Validate new password
    const validation = validatePassword(newPassword, user.email);
    if (!validation.isValid) {
      await logAuthEvent(env(c), {
        userId,
        eventType: 'password_reset',
        status: 'failed',
        details: { reason: 'invalid_password', errors: validation.errors },
      });

      return c.json(
        { success: false, message: 'Password does not meet security requirements', errors: validation.errors },
        400
      );
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));

    // Update password
    await execQuery(env(c), 'UPDATE users SET passwordhash = $1, password_changed_at = NOW() WHERE users_id = $2', [
      newPasswordHash,
      userId,
    ]);

    // Invalidate token
    await execQuery(
      env(c),
      'UPDATE password_reset_tokens SET is_used = true WHERE user_id = $1 AND is_used = false',
      [userId]
    );

    // Log successful password reset
    await logAuthEvent(env(c), {
      userId,
      eventType: 'password_reset',
      status: 'success',
    });

    return c.json({
      success: true,
      message: 'Password reset successfully. Please log in with your new password.',
    });
  } catch (error: any) {
    logError('Reset password error:', error);
    return c.json({ success: false, message: 'Failed to reset password' }, 500);
  }
});

// ===== PROTECTED ROUTES =====

auth.use('/change-password', authenticateToken);
auth.use('/2fa/*', authenticateToken);
auth.use('/verify', authenticateToken);
auth.use('/logout', authenticateToken);

/**
 * POST /logout
 * Invalidate session (JWT is stateless; client must clear token on its end)
 */
auth.post('/logout', async (c) => {
  try {
    const partial = c.get('user');
    await logAuthEvent(env(c), {
      userId: partial?.users_id,
      eventType: 'logout',
      status: 'success',
      ipAddress: c.req.header('cf-connecting-ip') || undefined,
      userAgent: c.req.header('user-agent') || undefined,
    });
    return c.json({ success: true, message: 'Logged out successfully' });
  } catch (error: any) {
    logError('Logout error:', error);
    return c.json({ success: true, message: 'Logged out' });
  }
});

/**
 * POST /change-password
 * Change user's password (requires current password)
 */
auth.post('/change-password', async (c) => {
  try {
    const body = await c.req.json();
    const { currentPassword, newPassword, confirmPassword } = body;

    // Manual validation
    if (!currentPassword) {
      return c.json(
        { success: false, message: 'Validation failed', errors: [{ msg: 'Current password is required' }] },
        400
      );
    }
    if (!newPassword) {
      return c.json(
        { success: false, message: 'Validation failed', errors: [{ msg: 'New password is required' }] },
        400
      );
    }
    if (!confirmPassword) {
      return c.json(
        { success: false, message: 'Validation failed', errors: [{ msg: 'Password confirmation is required' }] },
        400
      );
    }

    const currentUser = c.get('user');
    const userId = currentUser.users_id;

    // Verify passwords match
    if (newPassword !== confirmPassword) {
      await logAuthEvent(env(c), {
        userId,
        eventType: 'password_change',
        status: 'failed',
        details: { reason: 'passwords_do_not_match' },
      });

      return c.json({ success: false, message: 'Passwords do not match' }, 400);
    }

    // Get user with password hash
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE users_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }
    const user = userResult.rows[0];

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.passwordhash);
    if (!isCurrentPasswordValid) {
      await logAuthEvent(env(c), {
        userId,
        eventType: 'password_change',
        status: 'failed',
        details: { reason: 'invalid_current_password' },
      });

      return c.json({ success: false, message: 'Current password is incorrect' }, 401);
    }

    // Validate new password
    const validation = validatePassword(newPassword, user.email);
    if (!validation.isValid) {
      await logAuthEvent(env(c), {
        userId,
        eventType: 'password_change',
        status: 'failed',
        details: { reason: 'invalid_password', errors: validation.errors },
      });

      return c.json(
        { success: false, message: 'Password does not meet security requirements', errors: validation.errors },
        400
      );
    }

    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(newPassword, user.passwordhash);
    if (isSamePassword) {
      await logAuthEvent(env(c), {
        userId,
        eventType: 'password_change',
        status: 'failed',
        details: { reason: 'same_as_current' },
      });

      return c.json({ success: false, message: 'New password must be different from current password' }, 400);
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));

    // Update password
    await execQuery(env(c), 'UPDATE users SET passwordhash = $1, password_changed_at = NOW() WHERE users_id = $2', [
      newPasswordHash,
      userId,
    ]);

    // Log successful password change
    await logAuthEvent(env(c), {
      userId,
      eventType: 'password_change',
      status: 'success',
    });

    return c.json({
      success: true,
      message: 'Password changed successfully. Please log in again.',
    });
  } catch (error: any) {
    logError('Change password error:', error);
    return c.json({ success: false, message: 'Failed to change password' }, 500);
  }
});

// ===== 2FA MANAGEMENT =====

/**
 * POST /2fa/setup
 * Setup 2FA method - Generate setup data (TOTP secret + QR code, or phone verification)
 */
auth.post('/2fa/setup', async (c) => {
  try {
    const body = await c.req.json();
    const { method, phoneNumber } = body;

    // Manual validation
    if (!['totp', 'email_otp', 'sms_otp'].includes(method)) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Invalid 2FA method' }] }, 400);
    }

    const currentUser = c.get('user');
    const userId = currentUser.users_id;

    // Get user
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE users_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }
    const user = userResult.rows[0];

    let setupData: any = {};

    if (method === 'totp') {
      // Generate TOTP secret
      const secret = speakeasy.generateSecret({
        name: `MeterItPro (${user.email})`,
        issuer: 'MeterItPro',
        length: 20,
      });

      setupData = {
        secret: secret.base32,
        otpauth_url: secret.otpauth_url,
        method: 'totp',
      };
    } else if (method === 'email_otp') {
      setupData = {
        message: 'Email OTP will be sent to your email during login',
        method: 'email_otp',
      };
    } else if (method === 'sms_otp') {
      if (!phoneNumber) {
        return c.json({ success: false, message: 'Phone number is required for SMS OTP' }, 400);
      }
      setupData = {
        phone_number: phoneNumber,
        message: 'SMS OTP will be sent to your phone during login',
        method: 'sms_otp',
      };
    }

    return c.json({
      success: true,
      data: setupData,
    });
  } catch (error: any) {
    logError('2FA setup error:', error);
    return c.json({ success: false, message: 'Failed to setup 2FA' }, 500);
  }
});

/**
 * POST /2fa/verify-setup
 * Verify 2FA setup and enable method
 */
auth.post('/2fa/verify-setup', async (c) => {
  try {
    const body = await c.req.json();
    const { method, code, secret, phoneNumber } = body;

    // Manual validation
    if (!['totp', 'email_otp', 'sms_otp'].includes(method)) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Invalid 2FA method' }] }, 400);
    }
    if (!code) {
      return c.json(
        { success: false, message: 'Validation failed', errors: [{ msg: 'Verification code is required' }] },
        400
      );
    }

    const currentUser = c.get('user');
    const userId = currentUser.users_id;

    let isValid = false;

    if (method === 'totp') {
      if (!secret) {
        return c.json({ success: false, message: 'TOTP secret is required' }, 400);
      }
      isValid = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token: code,
        window: 1,
      });
    }
    // email_otp and sms_otp verification would need external service integration

    if (!isValid) {
      await logAuthEvent(env(c), {
        userId,
        eventType: '2fa_enable',
        status: 'failed',
        details: { method, reason: 'invalid_code' },
      });

      return c.json({ success: false, message: 'Invalid verification code' }, 400);
    }

    // Store 2FA method in database
    try {
      await execQuery(
        env(c),
        `INSERT INTO user_2fa_methods (user_id, method_type, secret_key, phone_number, is_enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, NOW(), NOW())
         ON CONFLICT (user_id, method_type) DO UPDATE SET
         secret_key = EXCLUDED.secret_key,
         phone_number = EXCLUDED.phone_number,
         is_enabled = true,
         updated_at = NOW()`,
        [userId, method, method === 'totp' ? secret : null, method === 'sms_otp' ? phoneNumber : null]
      );
    } catch (dbError) {
      console.error('Error storing 2FA method:', dbError);
      await logAuthEvent(env(c), {
        userId,
        eventType: '2fa_enable',
        status: 'failed',
        details: { method, reason: 'database_error' },
      });

      return c.json({ success: false, message: 'Failed to store 2FA method' }, 500);
    }

    // Generate backup codes for TOTP
    let backupCodes: { code: string }[] = [];
    if (method === 'totp') {
      backupCodes = generateBackupCodes(10);
      try {
        await storeBackupCodes(env(c), userId, backupCodes);
      } catch (backupError) {
        console.error('Error storing backup codes:', backupError);
      }
    }

    // Log 2FA enable
    await logAuthEvent(env(c), {
      userId,
      eventType: '2fa_enable',
      status: 'success',
      details: { method },
    });

    return c.json({
      success: true,
      message: '2FA method enabled successfully',
      data: {
        backup_codes: method === 'totp' ? backupCodes.map((bc) => bc.code) : undefined,
      },
    });
  } catch (error: any) {
    logError('2FA verify setup error:', error);
    return c.json({ success: false, message: 'Failed to verify 2FA setup' }, 500);
  }
});

/**
 * GET /2fa/methods
 * Get user's 2FA methods
 */
auth.get('/2fa/methods', async (c) => {
  try {
    const currentUser = c.get('user');
    const userId = currentUser.users_id;

    const result = await execQuery(
      env(c),
      `SELECT method_type, is_enabled, created_at FROM user_2fa_methods
       WHERE user_id = $1 AND is_enabled = true
       ORDER BY created_at DESC`,
      [userId]
    );

    const methods = result.rows
      ? result.rows.map((row: any) => ({
          type: row.method_type,
          enabled: row.is_enabled,
          created_at: row.created_at,
        }))
      : [];

    return c.json({
      success: true,
      data: { methods },
    });
  } catch (error: any) {
    logError('Get 2FA methods error:', error);
    return c.json({ success: false, message: 'Failed to get 2FA methods' }, 500);
  }
});

/**
 * POST /2fa/disable
 * Disable 2FA method
 */
auth.post('/2fa/disable', async (c) => {
  try {
    const body = await c.req.json();
    const { method, password } = body;

    // Manual validation
    if (!['totp', 'email_otp', 'sms_otp'].includes(method)) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Invalid 2FA method' }] }, 400);
    }
    if (!password) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Password is required' }] }, 400);
    }

    const currentUser = c.get('user');
    const userId = currentUser.users_id;

    // Get user with password hash
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE users_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }
    const user = userResult.rows[0];

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordhash);
    if (!isPasswordValid) {
      await logAuthEvent(env(c), {
        userId,
        eventType: '2fa_disable',
        status: 'failed',
        details: { method, reason: 'invalid_password' },
      });

      return c.json({ success: false, message: 'Password is incorrect' }, 401);
    }

    // Disable 2FA method
    const result = await execQuery(
      env(c),
      `UPDATE user_2fa_methods SET is_enabled = false, updated_at = NOW()
       WHERE user_id = $1 AND method_type = $2
       RETURNING method_type`,
      [userId, method]
    );

    if (!result.rows || result.rows.length === 0) {
      return c.json({ success: false, message: '2FA method not found' }, 404);
    }

    // If disabling TOTP, also delete backup codes
    if (method === 'totp') {
      await execQuery(env(c), 'DELETE FROM user_2fa_backup_codes WHERE user_id = $1', [userId]);
    }

    // Log 2FA disable
    await logAuthEvent(env(c), {
      userId,
      eventType: '2fa_disable',
      status: 'success',
      details: { method },
    });

    return c.json({
      success: true,
      message: '2FA method disabled successfully',
    });
  } catch (error: any) {
    logError('Disable 2FA error:', error);
    return c.json({ success: false, message: 'Failed to disable 2FA' }, 500);
  }
});

/**
 * POST /2fa/regenerate-backup-codes
 * Regenerate backup codes for TOTP
 */
auth.post('/2fa/regenerate-backup-codes', async (c) => {
  try {
    const body = await c.req.json();
    const { password } = body;

    // Manual validation
    if (!password) {
      return c.json({ success: false, message: 'Validation failed', errors: [{ msg: 'Password is required' }] }, 400);
    }

    const currentUser = c.get('user');
    const userId = currentUser.users_id;

    // Get user with password hash
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE users_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return c.json({ success: false, message: 'User not found' }, 404);
    }
    const user = userResult.rows[0];

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordhash);
    if (!isPasswordValid) {
      return c.json({ success: false, message: 'Password is incorrect' }, 401);
    }

    // Check if user has TOTP enabled
    const totpResult = await execQuery(
      env(c),
      `SELECT user_2fa_methods_id FROM user_2fa_methods
       WHERE user_id = $1 AND method_type = 'totp' AND is_enabled = true`,
      [userId]
    );

    if (!totpResult.rows || totpResult.rows.length === 0) {
      return c.json({ success: false, message: 'TOTP 2FA is not enabled for this account' }, 400);
    }

    // Generate new backup codes
    const backupCodes = generateBackupCodes(10);

    // Store new codes (replaces old ones)
    try {
      await storeBackupCodes(env(c), userId, backupCodes);
    } catch (backupError) {
      console.error('Error storing backup codes:', backupError);
      return c.json({ success: false, message: 'Failed to regenerate backup codes' }, 500);
    }

    return c.json({
      success: true,
      message: 'Backup codes regenerated successfully',
      data: {
        backup_codes: backupCodes.map((bc) => bc.code),
      },
    });
  } catch (error: any) {
    logError('Regenerate backup codes error:', error);
    return c.json({ success: false, message: 'Failed to regenerate backup codes' }, 500);
  }
});

/**
 * GET /verify
 * Verify JWT token and return user information
 */
auth.get('/verify', async (c) => {
  try {
    const partial = c.get('user');

    // Load full user from DB (cached) � authenticateToken only sets users_id/tenant_id from JWT
    const currentUser = await getCachedUser(c.env, String(partial.users_id));
    if (!currentUser) {
      return c.json({ success: false, message: 'User not found' }, 401);
    }

    // Admin impersonation: return synthetic user scoped to the target tenant
    if ((partial as any).isAdminView) {
      const adminPerms = getPermissionsByRole('admin');
      return c.json({
        success: true,
        data: {
          user: {
            ...currentUser,
            role: 'admin',
            client: String(partial.tenant_id),
            tenant_id: partial.tenant_id,
            permissions: adminPerms,
            isAdminView: true,
            adminViewTenantName: (partial as any).viewingTenantName || '',
          },
        },
      });
    }

    // Derive permissions from role
    const userRole = (currentUser.role || 'viewer').toLowerCase();
    let permissions = getPermissionsByRole(userRole);

    // If user has permissions in database, use those instead
    if (currentUser.permissions && typeof currentUser.permissions === 'object' && !Array.isArray(currentUser.permissions)) {
      permissions = currentUser.permissions;
    }

    const userResponse = {
      ...currentUser,
      users_id: currentUser.users_id,
      permissions,
      client: currentUser.tenant_id,
    };

    return c.json({
      success: true,
      data: {
        user: userResponse,
      },
    });
  } catch (error: any) {
    logError('Token verification error:', error);
    return c.json({ success: false, message: 'Token verification failed' }, 500);
  }
});

/**
 * POST /refresh
 * Refresh access token using refresh token
 */
auth.post('/refresh', async (c) => {
  try {
    const body = await c.req.json();
    const { refreshToken: refreshTokenValue } = body;

    if (!refreshTokenValue) {
      return c.json({ success: false, message: 'Refresh token is required' }, 400);
    }

    // Verify refresh token
    let decoded: any;
    try {
      console.log('[REFRESH] Verifying refresh token, length:', refreshTokenValue.length);
      decoded = await verify(refreshTokenValue, c.env.JWT_SECRET, 'HS256');
      console.log('[REFRESH] Token verified, decoded:', JSON.stringify(decoded));
      if (!decoded.isRefresh) {
        console.log('[REFRESH] Token missing isRefresh claim');
        return c.json({ success: false, message: 'Invalid refresh token' }, 401);
      }
    } catch (err: any) {
      console.error('[REFRESH] Token verify error:', err?.message || err, 'name:', err?.name);
      return c.json({ success: false, message: 'Refresh token expired or invalid' }, 401);
    }

    const userId = decoded.userId;
    const tenantId = decoded.tenant_id;

    // Look up user to ensure they still exist and are active
    const userResult = await execQuery(env(c), 'SELECT * FROM users WHERE users_id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return c.json({ success: false, message: 'User not found' }, 401);
    }

    const user = userResult.rows[0];
    if (!user.active) {
      return c.json({ success: false, message: 'Account is inactive' }, 401);
    }

    // Generate new tokens
    const newToken = await generateToken(userId, tenantId, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN);
    const newRefreshToken = await generateRefreshToken(userId, tenantId, c.env.JWT_SECRET);

    // Derive permissions
    const userRole = (user.role || 'viewer').toLowerCase();
    let permissions = getPermissionsByRole(userRole);
    if (user.permissions && typeof user.permissions === 'object' && !Array.isArray(user.permissions)) {
      permissions = user.permissions;
    }

    return c.json({
      success: true,
      data: {
        user: {
          users_id: user.users_id,
          tenant_id: user.tenant_id,
          client: user.tenant_id,
          email: user.email,
          name: user.name,
          role: user.role,
          permissions,
          status: user.active ? 'active' : 'inactive',
          is_super_admin: user.is_super_admin || false,
          is_support_admin: user.is_support_admin || false,
        },
        token: newToken,
        refreshToken: newRefreshToken,
        expiresIn: 60 * 60,
      },
    });
  } catch (error: any) {
    logError('Token refresh error:', error);
    return c.json({ success: false, message: 'Token refresh failed' }, 500);
  }
});

// ===== HELPER =====

/** Shorthand to extract c.env typed as Env */
function env(c: any): Env {
  return c.env;
}

export default auth;
