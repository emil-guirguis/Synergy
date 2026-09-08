/**
 * Settings routes - Hono worker
 */

import { Hono } from 'hono';
import { Env, execQuery } from '../db';

import { authenticateToken, requirePermission, AuthVariables } from '../middleware';
import { logError } from '../errorHandler';
import { rowToBasicSettings, basicSettingsToRow } from '@meterit/framework-backend/api/base/settings';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authenticateToken);

/** Map a tenant row to the CompanySettings shape the frontend expects.
 * Base fields (name/address/contactInfo/systemConfig) come from the shared
 * framework mapper; features/integrations are MeterItPro-specific. */
function tenantToSettings(tenant: any) {
  const base = rowToBasicSettings(tenant);
  return {
    id: String(tenant.tenant_id),
    logo: null,
    ...base,
    features: {
      userManagement: true,
      locationManagement: true,
      meterManagement: true,
      contactManagement: true,
      emailTemplates: true,
      reporting: true,
      analytics: true,
      mobileApp: false,
      apiAccess: true,
    },
    integrations: {
      emailProvider: null,
      smsProvider: null,
      paymentProcessor: null,
      calendarSync: false,
      weatherAPI: false,
      mapProvider: '',
    },
  };
}

// GET /company - Get company settings
app.get('/company', requirePermission('settings:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ success: false, message: 'Tenant ID not found in user context' }, 400);
    }

    const result = await execQuery(
      c.env,
      'SELECT * FROM public.tenant WHERE tenant_id = $1 LIMIT 1',
      [tenantId]
    );

    if (result.rows.length === 0) {
      return c.json({ success: false, message: 'Tenant not found' }, 404);
    }

    return c.json({ success: true, data: tenantToSettings(result.rows[0]) });
  } catch (error: any) {
    logError('Error fetching company settings:', error);
    return c.json({
      success: false,
      message: 'Failed to fetch company settings',
      error: error.message,
    }, 500);
  }
});

// PUT /company - Update company settings
app.put('/company', requirePermission('settings:update'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ success: false, message: 'Tenant ID not found in user context' }, 400);
    }

    const body = await c.req.json();
    const updateData = basicSettingsToRow(body);
    if (Object.keys(updateData).length === 0) {
      return c.json({ success: true, message: 'No fields to update' });
    }

    const setClause: string[] = [];
    const values: any[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updateData)) {
      setClause.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }

    setClause.push(`updated_at = NOW()`);
    values.push(tenantId);

    const sql = `UPDATE public.tenant SET ${setClause.join(', ')} WHERE tenant_id = $${idx} RETURNING *`;
    const result = await execQuery(c.env, sql, values);

    return c.json({
      success: true,
      data: tenantToSettings(result.rows[0]),
      message: 'Company settings updated successfully',
    });
  } catch (error: any) {
    logError('Error updating company settings:', error);
    return c.json({
      success: false,
      message: 'Failed to update company settings',
      error: error.message,
    }, 500);
  }
});

// GET / - Legacy endpoint for backward compatibility
app.get('/', requirePermission('settings:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ success: false, message: 'Tenant ID not found in user context' }, 400);
    }

    const result = await execQuery(
      c.env,
      'SELECT * FROM public.tenant WHERE tenant_id = $1 LIMIT 1',
      [tenantId]
    );

    if (result.rows.length === 0) {
      return c.json({ success: false, message: 'Tenant not found' }, 404);
    }

    return c.json({ success: true, data: { company: tenantToSettings(result.rows[0]) } });
  } catch (error: any) {
    logError('Error fetching settings:', error);
    return c.json({
      success: false,
      message: 'Failed to fetch settings',
      error: error.message,
    }, 500);
  }
});

export default app;
