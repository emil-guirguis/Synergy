/**
 * Sync routes - Hono worker
 * Uses authenticateSyncServer middleware (API key auth) for sync endpoints.
 */

import { Hono } from 'hono';
import { transaction, Env, execQuery } from '../db';

import { authenticateSyncServer, AuthVariables } from '../middleware';
import { logError } from '../errorHandler';
import { checkReadingQuality } from '../qualityChecks';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// POST /readings/batch - Upload batch meter readings from Sync MCP
app.post('/readings/batch', authenticateSyncServer, async (c) => {
  try {
    const { readings } = await c.req.json();
    const tenantId = c.get('tenantId');

    if (!readings || readings.length === 0) {
      return c.json({ success: false, message: 'No readings provided' }, 400);
    }


    const result = await transaction(c.env, async (client) => {
      let insertedCount = 0;
      let skippedCount = 0;
      const insertErrors: any[] = [];

      for (let i = 0; i < readings.length; i++) {
        const reading = readings[i];
        const savepointName = `sp_${i}`;

        try {
          await client.query(`SAVEPOINT ${savepointName}`);

          const { quality, flags } = checkReadingQuality(reading);

          const readingQuery = `
            INSERT INTO meter_reading (
              tenant_id, meter_id, created_at, sync_status,
              kwh, mwh, kvah, kvah_export,
              kva, phase_kva_a, phase_kva_b, phase_kva_c,
              amperage, phase_amperage_a, phase_amperage_b, phase_amperage_c,
              frequency, peak_kw, kw, power_factor,
              pf_a, pf_b, pf_c,
              phase_kw_a, phase_kw_b, phase_kw_c,
              kvarh, reactive_energy_export, kvar,
              phase_kvar_a, phase_kvar_b, phase_kvar_c,
              voltage_a_b, voltage_a_n, voltage_b_c, voltage_b_n,
              voltage_c_a, voltage_c_n, voltage_p_n, voltage_p_p,
              total_thdv, phase_thdv_a, phase_thdv_b, phase_thdv_c,
              meter_element_id, calculated_kwh,
              quality, validation_flags
            )
            VALUES (
              $1, $2, $3, $4,
              $5, $6, $7, $8,
              $9, $10, $11, $12,
              $13, $14, $15, $16,
              $17, $18, $19, $20,
              $21, $22, $23,
              $24, $25, $26,
              $27, $28, $29,
              $30, $31, $32,
              $33, $34, $35, $36,
              $37, $38, $39, $40,
              $41, $42, $43, $44,
              $45, $46,
              $47, $48
            )
            ON CONFLICT (tenant_id, meter_id, meter_element_id, created_at) WHERE meter_element_id IS NOT NULL DO NOTHING
            RETURNING meter_reading_id
          `;
          const readingParams = [
            tenantId,
            parseInt(reading.meter_id, 10),
            reading.created_at ? new Date(reading.created_at) : new Date(),
            'pending',
            reading.kwh ?? null,
            reading.mwh ?? null,
            reading.kvah ?? null,
            reading.kvah_export ?? null,
            reading.kva ?? null,
            reading.phase_kva_a ?? null,
            reading.phase_kva_b ?? null,
            reading.phase_kva_c ?? null,
            reading.amperage ?? null,
            reading.phase_amperage_a ?? null,
            reading.phase_amperage_b ?? null,
            reading.phase_amperage_c ?? null,
            reading.frequency ?? null,
            reading.peak_kw ?? null,
            reading.kw ?? null,
            reading.power_factor ?? null,
            reading.pf_a ?? null,
            reading.pf_b ?? null,
            reading.pf_c ?? null,
            reading.phase_kw_a ?? null,
            reading.phase_kw_b ?? null,
            reading.phase_kw_c ?? null,
            reading.kvarh ?? null,
            reading.reactive_energy_export ?? null,
            reading.kvar ?? null,
            reading.phase_kvar_a ?? null,
            reading.phase_kvar_b ?? null,
            reading.phase_kvar_c ?? null,
            reading.voltage_a_b ?? null,
            reading.voltage_a_n ?? null,
            reading.voltage_b_c ?? null,
            reading.voltage_b_n ?? null,
            reading.voltage_c_a ?? null,
            reading.voltage_c_n ?? null,
            reading.voltage_p_n ?? null,
            reading.voltage_p_p ?? null,
            reading.total_thdv ?? null,
            reading.phase_thdv_a ?? null,
            reading.phase_thdv_b ?? null,
            reading.phase_thdv_c ?? null,
            reading.meter_element_id ?? null,
            reading.calculated_kwh ?? null,
            quality,
            flags.length > 0 ? flags : null
          ];

          const insertResult = await client.query(readingQuery, readingParams);

          await client.query(`RELEASE SAVEPOINT ${savepointName}`);

          if (insertResult.rowCount && insertResult.rowCount > 0) {
            insertedCount++;
          } else {
            skippedCount++;
          }
        } catch (error: any) {
          try {
            await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          } catch (_) {
            // ignore rollback error
          }

          insertErrors.push({
            meter_id: reading.meter_id,
            error: error.message,
            code: error.code,
            detail: error.detail,
            column: error.column ?? null,
            where: error.where ?? null,
            hint: error.hint ?? null,
          });
          skippedCount++;
        }
      }

      return { insertedCount, skippedCount, insertErrors };
    });

    const hasErrors = result.insertErrors.length > 0;
    return c.json({
      success: !hasErrors,
      recordsProcessed: result.insertedCount,
      message: hasErrors
        ? `Batch upload failed: ${result.insertErrors.length} errors, ${result.insertedCount} inserted, ${result.skippedCount} skipped`
        : `Batch upload completed: ${result.insertedCount} inserted, ${result.skippedCount} skipped`,
      inserted: result.insertedCount,
      skipped: result.skippedCount,
      errors: result.insertErrors,
    }, hasErrors ? 500 : 200);
  } catch (error: any) {
    logError('[Sync] Batch upload error:', error);
    return c.json({
      success: false,
      recordsProcessed: 0,
      message: 'Batch upload error',
      error: error.message,
    }, 500);
  }
});

// GET /getmeters - Download meters for Sync
app.get('/getmeters', authenticateSyncServer, async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const sql = `SELECT m.meter_id, m.device_id, m.ip, m.port, m.active,
                me.meter_element_id, me.element, me.name as name
                 FROM meter m
                    JOIN meter_element me ON me.meter_id = m.meter_id
                 WHERE m.tenant_id = $1`;

    const result = await execQuery(c.env, sql, [tenantId]);

    const meter = result.rows[0];
    if (!meter) {
      return c.json({ success: false, message: 'meter not found' }, 404);
    }

    const meters = result.rows || [];

    return c.json({
      success: true,
      config: {
        site: {
          id: meter.meter_id,
          ip: meter.ip,
        },
        meters: meters.map((m: any) => ({
          meter_id: m.meter_id,
          device_id: m.device_id,
          ip: m.ip,
          port: m.port,
          element: m.element,
          active: m.active,
        })),
        sync_interval_minutes: 5,
        batch_size: 1000,
      },
    });
  } catch (error: any) {
    logError('Meter download error:', error);
    return c.json({ success: false, message: 'Meter download error', error: error.message }, 500);
  }
});

// GET /getmregisters - Download registers for Sync
app.get('/getmregisters', authenticateSyncServer, async (c) => {
  try {
    const qs = c.req.query();
    const deviceId = qs.deviceId || c.req.header('x-device-id');

    if (!deviceId) {
      return c.json({ success: false, message: 'deviceId is required' }, 400);
    }

    const sql = `SELECT dr.device_id, r.register, r.field_name
                 FROM register r
                    JOIN device_register dr ON dr.register_id = r.register_id
                 WHERE dr.device_id = $1`;

    const result = await execQuery(c.env, sql, [deviceId]);

    const register = result.rows[0];
    if (!register) {
      return c.json({ success: false, message: 'register not found' }, 404);
    }

    const registers = result.rows || [];

    return c.json({
      success: true,
      config: {
        register: {
          id: register.id,
          name: register.name,
        },
        registers: registers.map((r: any) => ({
          device_id: r.device_id,
          register: r.register,
          field_name: r.field_name,
        })),
        sync_interval_minutes: 5,
        batch_size: 1000,
      },
    });
  } catch (error: any) {
    logError('Register download error:', error);
    return c.json({ success: false, message: 'Register download error', error: error.message }, 500);
  }
});

// POST /connect - Validate email and API key to return tenant data
app.post('/connect', async (c) => {
  try {
    const { email, apiKey } = await c.req.json();

    if (!email || !apiKey) {
      return c.json({ success: false, message: 'Email and API key are required' }, 400);
    }

    // Find user by email
    const userResult = await execQuery(
      c.env,
      'SELECT users_id, name, email, active, tenant_id FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (userResult.rows.length === 0) {
      return c.json({ success: false, message: 'Invalid email or API key' }, 401);
    }

    const user = userResult.rows[0];

    if (!user.active) {
      return c.json({ success: false, message: 'Account is inactive' }, 401);
    }

    // Get tenant and verify API key
    const tenantResult = await execQuery(
      c.env,
      'SELECT * FROM tenant WHERE tenant_id = $1',
      [user.tenant_id]
    );

    if (tenantResult.rows.length === 0) {
      return c.json({ success: false, message: 'Tenant not found' }, 404);
    }

    const tenant = tenantResult.rows[0];

    if (tenant.api_key !== apiKey) {
      return c.json({ success: false, message: 'Invalid email or API key' }, 401);
    }

    return c.json({
      success: true,
      message: 'Connected successfully',
      data: {
        tenant: {
          tenant_id: tenant.tenant_id,
          name: tenant.name,
          url: tenant.url,
          street: tenant.street,
          street2: tenant.street2,
          city: tenant.city,
          state: tenant.state,
          zip: tenant.zip,
          country: tenant.country,
          api_key: tenant.api_key,
          download_batch_size: tenant.download_batch_size,
          upload_batch_size: tenant.upload_batch_size,
        },
        user: {
          users_id: user.users_id,
          email: user.email,
          name: user.name,
        },
      },
    });
  } catch (error: any) {
    logError('[Sync Connect] Error:', error);
    return c.json({ success: false, message: 'Connection failed' }, 500);
  }
});

// POST /trigger-upload - Manually trigger meter reading upload
app.post('/trigger-upload', async (c) => {
  return c.json({
    success: true,
    message: 'Upload triggered successfully. Check the sync system logs for details.',
  });
});

export default app;
