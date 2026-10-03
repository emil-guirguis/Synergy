/**
 * Schema routes - Hono worker
 *
 * Uses the SAME SchemaDefinition.js framework as the Node.js API.
 * Each entity's defineSchema() call is copied verbatim from its WithSchema model file.
 * The toJSON() pipeline produces identical output to the Node.js API.
 */

import { Hono } from 'hono';
import { Env } from '../db';
import { AuthVariables, authenticateToken } from '../middleware';
import { locationSchema } from './locationSchema';
import { meterSchema } from './meterSchema';
import { contactSchema } from './contactSchema';
import { deviceSchema } from './deviceSchema';
import { userSchema } from './usersSchema';
import { tenantSchema } from './tenantSchema';
import { meterReadingSchema } from './meterReadingSchema';
import { meterElementsSchema } from './meterElementSchema';
import { reportSchema } from './reportSchema';
import { dashboardSchema } from './dashboardSchema';
import { authLogsSchema } from './authLogsSchema';
import { emailTemplatesSchema } from './emailTemplatesSchema';
import { notificationSchema } from './notificationSchema';
import { notificationSettingsSchema } from './notificationSettingsSchema';
import { notificationRuleSchema } from './notificationRuleSchema';
import { syncServerSchema } from './syncServerSchema';
import { adminSyncServerSchema } from './adminSyncServerSchema';
import { costSchema } from './costSchema';
import { supportTicketSchema } from '@meterit/framework-backend/api/base/supportTicketSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Protect all schema routes with authentication
app.use('*', authenticateToken);

// ---------------------------------------------------------------------------
// SCHEMA DEFINITIONS - copied verbatim from each *WithSchema.js model file
// ---------------------------------------------------------------------------








// ---------------------------------------------------------------------------
// SCHEMA REGISTRY - maps entity names to their defineSchema() results
// ---------------------------------------------------------------------------
const schemas: Record<string, any> = {
  meter: meterSchema,
  location: locationSchema,
  contact: contactSchema,
  device: deviceSchema,
  user: userSchema,
  tenant: tenantSchema,
  meter_reading: meterReadingSchema,
  meterReadings: { $ref: 'meter_reading' },
  meterElements: meterElementsSchema,
  report: reportSchema,
  dashboard: dashboardSchema,
  authLogs: authLogsSchema,
  emailTemplates: emailTemplatesSchema,
  notification: notificationSchema,
  notification_settings: notificationSettingsSchema,
  notification_rule: notificationRuleSchema,
  sync_server: syncServerSchema,
  admin_sync_server: adminSyncServerSchema,
  cost: costSchema,
  support_ticket: supportTicketSchema,
};

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

function resolveSchema(key: string): any {
  const schema = schemas[key];
  if (!schema) return null;
  if (schema.$ref) return schemas[schema.$ref] || null;
  return schema;
}

// GET / - Get list of all available schemas
app.get('/', (c) => {
  try {
    const availableSchemas = Object.keys(schemas)
      .filter((k) => !schemas[k].$ref)
      .map((entityName) => {
        const schema = schemas[entityName];
        const json = schema.toJSON();
        return {
          entityName: json.entityName,
          tableName: json.tableName,
          description: json.description,
          endpoint: `/api/schema/${entityName}`,
        };
      });

    return c.json({
      success: true,
      data: {
        schemas: availableSchemas,
        count: availableSchemas.length,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, message: 'Failed to fetch schema list', error: error.message }, 500);
  }
});

// GET /:entity - Get schema for a specific entity
app.get('/:entity', (c) => {
  try {
    const entity = c.req.param('entity');
    const schema = resolveSchema(entity);

    if (!schema) {
      return c.json({ success: false, message: `Schema not found for entity: ${entity}`, availableEntities: Object.keys(schemas) }, 404);
    }

    // Use toJSON() - the SAME serialization pipeline as the Node.js API
    return c.json({ success: true, data: schema.toJSON() });
  } catch (error: any) {
    return c.json({ success: false, message: 'Failed to fetch schema', error: error.message }, 500);
  }
});

// POST /:entity/validate - Validate data against entity schema
app.post('/:entity/validate', async (c) => {
  try {
    const entity = c.req.param('entity');
    const schema = resolveSchema(entity);

    if (!schema) {
      return c.json({ success: false, message: `Schema not found for entity: ${entity}` }, 404);
    }

    const data = await c.req.json();
    const result = schema.validate(data);

    return c.json({ success: true, data: result });
  } catch (error: any) {
    return c.json({ success: false, message: 'Failed to validate data', error: error.message }, 500);
  }
});

export default app;
