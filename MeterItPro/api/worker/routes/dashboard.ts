/**
 * Dashboard routes - Hono worker
 * Card CRUD, readings queries, power column discovery.
 */

import { Hono } from 'hono';
import { Env, execQuery } from '../db';

import { authenticateToken, requirePermission, AuthVariables } from '../middleware';
import { findAll, findById, create, update, remove } from '../crud';
import { logError } from '../errorHandler';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const VALID_METER_READING_COLUMNS = new Set([
  'kwh','mwh','kvah','kvah_export',
  'kva','phase_kva_a','phase_kva_b','phase_kva_c',
  'amperage','phase_amperage_a','phase_amperage_b','phase_amperage_c','frequency',
  'peak_kw','kw','pf','pf_a','pf_b',
  'pf_c','phase_kw_a','phase_kw_b','phase_kw_c',
  'kvarh','kvarh_export','kvar','phase_kvar_a',
  'phase_kvar_b','phase_kvar_c','voltage_a_b','voltage_a_n',
  'voltage_b_c','voltage_b_n','voltage_c_a','voltage_c_n','voltage_p_n','voltage_p_p',
  'total_thdv','phase_thdv_a','phase_thdv_b','phase_thdv_c',
  'calculated_kwh',
]);

app.use('*', authenticateToken);

/** Parse meter_selections from DB text back to array */
function parseMeterSelections(raw: any): any[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

// GET /cards - Retrieve all dashboard cards for the tenant
app.get('/cards', requirePermission('dashboard:read'), async (c) => {
  try {
    const qs = c.req.query();
    const page = parseInt(qs.page || '1') || 1;
    const limit = parseInt(qs.limit || '25') || 25;
    const tenantId = c.get('tenantId');

    if (!tenantId) {
      return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);
    }

    const where: Record<string, any> = {};
    if (qs.search) {
      where.card_name = qs.search;
    }

    const result = await findAll(c.env, {
      table: 'dashboard',
      primaryKey: 'dashboard_id',
      tenantId,
      page,
      limit,
      where,
      search: qs.search || undefined,
      searchFields: ['card_name'],
      sortBy: qs.sortBy,
      sortOrder: qs.sortOrder,
    });

    console.log('[Dashboard] GET /cards - Raw database rows:', result.rows.map((c: any) => ({ id: c.dashboard_id, grid_x: c.grid_x, grid_y: c.grid_y })));

    const items = result.rows.map((card: any, index: number) => {
      const cardIndex = (page - 1) * limit + index;
      return {
        ...card,
        dashboard_id: card.dashboard_id || card.id,
        grid_x: card.grid_x ?? 0,
        grid_y: card.grid_y ?? cardIndex * 520,
        grid_w: card.grid_w ?? 500,
        grid_h: card.grid_h ?? 500,
        meter_selections: parseMeterSelections(card.meter_selections),
      };
    });

    return c.json({
      success: true,
      data: {
        items,
        total: result.pagination.total,
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
        totalPages: result.pagination.totalPages,
      },
    });
  } catch (error: any) {
    logError('Error fetching cards', error);
    return c.json({ success: false, message: 'Failed to fetch dashboard cards' }, 500);
  }
});

// GET /cards/:id - Retrieve a single dashboard card
app.get('/cards/:id', requirePermission('dashboard:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const card = await findById(c.env, 'dashboard', 'dashboard_id', c.req.param('id'), tenantId);
    if (!card) return c.json({ success: false, message: 'Dashboard card not found' }, 404);

    console.log('[Dashboard] GET /cards/:id - Card data:', {
      card_id: card.dashboard_id,
      meter_selections: parseMeterSelections(card.meter_selections),
    });

    return c.json({
      success: true,
      data: {
        ...card,
        dashboard_id: card.dashboard_id,
        grid_x: card.grid_x ?? 0,
        grid_y: card.grid_y ?? 0,
        grid_w: card.grid_w ?? 500,
        grid_h: card.grid_h ?? 500,
        meter_selections: parseMeterSelections(card.meter_selections),
      },
    });
  } catch (error: any) {
    logError('Error fetching card', error);
    return c.json({ success: false, message: 'Failed to fetch dashboard card' }, 500);
  }
});

// GET /cards/:id/data - Retrieve aggregated data for a dashboard card
app.get('/cards/:id/data', requirePermission('dashboard:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const rawTz = c.req.query('tz') || 'UTC';
    // Whitelist: only allow valid IANA timezone characters to prevent SQL injection
    const tz = /^[A-Za-z0-9_/+-]{1,64}$/.test(rawTz) ? rawTz : 'UTC';

    const card = await findById(c.env, 'dashboard', 'dashboard_id', c.req.param('id'), tenantId);
    if (!card) return c.json({ success: false, message: 'Dashboard card not found' }, 404);

    // Parse meter_selections JSONB
    const rawMs = parseMeterSelections(card.meter_selections);

    console.log('[Dashboard] GET /cards/:id/data - Card loaded:', {
      card_name: card.card_name,
      meter_selections: rawMs,
    });

    // Derive selected columns and meter/element IDs from meter_selections
    let rawColumns: string[] = [];
    let meter_id: number | null = null;
    let meter_element_ids: number[] = [];
    let meter_element_id: number | null = null;

    if (Array.isArray(rawMs) && rawMs.length > 0) {
      // Collect meter_id, meter_element_ids, and register_field_names across all rows
      rawMs.forEach((row: any) => {
        // Get meter_id from first row (should be same for all rows)
        if (!meter_id && row.meter_id) {
          meter_id = row.meter_id;
        }
        // Collect all meter_element_ids (new format: array; legacy format: single value)
        if (Array.isArray(row.meter_element_ids)) {
          row.meter_element_ids.forEach((id: number) => { if (id) meter_element_ids.push(id); });
        } else if (row.meter_element_id) {
          meter_element_ids.push(row.meter_element_id);
        }
        // Collect all register_field_names across all rows, excluding '*'
        if (Array.isArray(row.register_field_names)) {
          row.register_field_names.forEach((fn: string) => {
            if (fn && fn !== '*') rawColumns.push(fn);
          });
        }
      });

      // Use first meter_element_id if available (or could use IN clause for multiple)
      meter_element_id = meter_element_ids.length > 0 ? meter_element_ids[0] : null;

      console.log('[Dashboard] GET /cards/:id/data - Extracted from meter_selections:', {
        meter_selections_raw: rawMs,
        extracted_meter_id: meter_id,
        extracted_meter_element_ids: meter_element_ids,
        using_meter_element_id: meter_element_id,
      });
    } else {
      // Legacy fallback
      let legacy = card.selected_columns;
      if (typeof legacy === 'string') { try { legacy = JSON.parse(legacy); } catch { legacy = []; } }
      if (Array.isArray(legacy)) rawColumns = legacy;

      console.log('[Dashboard] GET /cards/:id/data - Using legacy selected_columns:', legacy);
    }

    const selectedColumns: string[] = rawColumns
      .map((col: string) => columnNameMapping[col.toLowerCase()] || col.toLowerCase())
      .filter((col: string) => VALID_METER_READING_COLUMNS.has(col))
      .filter((col, idx, arr) => arr.indexOf(col) === idx);

    if (selectedColumns.length === 0) {
      return c.json({ success: true, data: { card_id: card.dashboard_id, aggregated_values: {}, grouped_data: [] } });
    }

    // Calculate time frame � query params override the card's stored settings
    const now = new Date();
    let startDate: Date;
    let endDate: Date;
    const overrideStart = c.req.query('start_date');
    const overrideEnd   = c.req.query('end_date');
    if (overrideStart && overrideEnd) {
      startDate = new Date(overrideStart);
      endDate   = new Date(overrideEnd);
    } else {
      const timeFrameType = card.time_frame_type || 'last_month';
      if (timeFrameType === 'today') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (timeFrameType === 'this_month_to_date') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      } else if (timeFrameType === 'yearly') {
        startDate = new Date(now.getFullYear(), 0, 1);
      } else if (timeFrameType === 'since_installation') {
        startDate = new Date('2000-01-01');
      } else if (timeFrameType === 'custom' && card.custom_start_date) {
        startDate = new Date(card.custom_start_date);
      } else {
        startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 1);
      }
      endDate = (timeFrameType === 'custom' && card.custom_end_date) ? new Date(card.custom_end_date) : now;
    }

    // Aggregation type � used for both aggregated_values and grouped_data
    const rawAggType = (card.aggregation_type || 'avg').toLowerCase();
    const isNoAgg = rawAggType === 'none';
    const aggFn = rawAggType === 'min' ? 'MIN' : rawAggType === 'max' ? 'MAX' : rawAggType === 'sum' ? 'SUM' : 'AVG';

    // Build WHERE clause and params based on what's set in meter_selections
    // Always join with meter_element and meter to ensure only active meters are included
    let whereClause: string;
    let aggParams: any[];
    const fromClause = 'FROM meter_reading mr JOIN meter_element me ON mr.meter_element_id = me.meter_element_id JOIN meter m ON me.meter_id = m.meter_id';

    // Build WHERE conditions based on what's in meter_selections
    let whereConditions = ['mr.tenant_id = $1', 'm.active = true'];
    aggParams = [tenantId];
    let paramIndex = 2;

    if (meter_id) {
      whereConditions.push(`m.meter_id = $${paramIndex}`);
      aggParams.push(meter_id);
      paramIndex++;
    }

    if (meter_element_ids.length > 0) {
      const placeholders = meter_element_ids.map((_, i) => `$${paramIndex + i}`).join(', ');
      whereConditions.push(`mr.meter_element_id IN (${placeholders})`);
      aggParams.push(...meter_element_ids);
      paramIndex += meter_element_ids.length;
    }

    // Add date range
    whereConditions.push(`mr.created_at >= $${paramIndex}`);
    whereConditions.push(`mr.created_at <= $${paramIndex + 1}`);
    aggParams.push(startDate, endDate);

    whereClause = 'WHERE ' + whereConditions.join(' AND ');

    // Determine aggregation function and grouping
    // When aggregation is 'none', use SUM as default (makes sense for consumption readings)
    const groupAggFn = isNoAgg ? 'SUM' : aggFn;
    const groupCols = selectedColumns.map((col: string) => `${groupAggFn}(${col}) as "${col}"`).join(', ');
    const groupingType = card.grouping_type || 'daily';

    const meterCols = `mr.meter_id as meter_id, mr.meter_element_id as meter_element_id, (CASE WHEN mr.meter_element_id IS NOT NULL THEN CONCAT(COALESCE(m.name, 'Unknown Meter'), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, 'Unknown')) ELSE COALESCE(m.name, 'Unknown Meter') END) as name`;

    // Raw columns for DISTINCT ON queries (no aggregation — returns the actual peak row)
    const rawCols = selectedColumns.map((col: string) => `mr.${col} as "${col}"`).join(', ');
    const primaryCol = selectedColumns[0];

    // Build both queries with the same grouping structure
    // aggSql  → GROUP BY + agg fn  → used for aggregated_values summary
    // groupSql → for MAX: DISTINCT ON with peaked_at; for others: same as aggSql
    let aggSql: string;
    let groupSql: string;

    if (groupingType === 'total') {
      aggSql = `SELECT ${meterCols}, ${groupCols} ${fromClause} ${whereClause} GROUP BY mr.meter_id, mr.meter_element_id, m.name, me.element, me.name`;
      groupSql = aggFn === 'MAX'
        ? `SELECT DISTINCT ON (mr.meter_element_id) ${meterCols}, ${rawCols}, mr.created_at as peaked_at ${fromClause} ${whereClause} ORDER BY mr.meter_element_id, mr.${primaryCol} DESC NULLS LAST`
        : aggSql;
    } else if (groupingType === 'hourly') {
      const hourExpr = `DATE(mr.created_at AT TIME ZONE '${tz}'), EXTRACT(HOUR FROM mr.created_at AT TIME ZONE '${tz}')::int`;
      const hourCols  = `DATE(mr.created_at AT TIME ZONE '${tz}') as date, EXTRACT(HOUR FROM mr.created_at AT TIME ZONE '${tz}')::int as hour`;
      aggSql = `SELECT ${hourCols}, ${meterCols}, ${groupCols} ${fromClause} ${whereClause} GROUP BY ${hourExpr}, mr.meter_id, mr.meter_element_id, m.name, me.element, me.name ORDER BY date, hour`;
      groupSql = aggFn === 'MAX'
        ? `SELECT DISTINCT ON (${hourExpr}, mr.meter_element_id) ${hourCols}, ${meterCols}, ${rawCols}, mr.created_at as peaked_at ${fromClause} ${whereClause} ORDER BY ${hourExpr}, mr.meter_element_id, mr.${primaryCol} DESC NULLS LAST`
        : aggSql;
    } else if (groupingType === 'weekly') {
      const weekExpr = `DATE_TRUNC('week', mr.created_at AT TIME ZONE '${tz}')::date`;
      const weekCols  = `${weekExpr} as week_start`;
      aggSql = `SELECT ${weekCols}, ${meterCols}, ${groupCols} ${fromClause} ${whereClause} GROUP BY DATE_TRUNC('week', mr.created_at AT TIME ZONE '${tz}'), mr.meter_id, mr.meter_element_id, m.name, me.element, me.name ORDER BY week_start`;
      groupSql = aggFn === 'MAX'
        ? `SELECT DISTINCT ON (${weekExpr}, mr.meter_element_id) ${weekCols}, ${meterCols}, ${rawCols}, mr.created_at as peaked_at ${fromClause} ${whereClause} ORDER BY ${weekExpr}, mr.meter_element_id, mr.${primaryCol} DESC NULLS LAST`
        : aggSql;
    } else if (groupingType === 'monthly') {
      const monthExpr = `DATE_TRUNC('month', mr.created_at AT TIME ZONE '${tz}')::date`;
      const monthCols  = `${monthExpr} as month_start`;
      aggSql = `SELECT ${monthCols}, ${meterCols}, ${groupCols} ${fromClause} ${whereClause} GROUP BY DATE_TRUNC('month', mr.created_at AT TIME ZONE '${tz}'), mr.meter_id, mr.meter_element_id, m.name, me.element, me.name ORDER BY month_start`;
      groupSql = aggFn === 'MAX'
        ? `SELECT DISTINCT ON (${monthExpr}, mr.meter_element_id) ${monthCols}, ${meterCols}, ${rawCols}, mr.created_at as peaked_at ${fromClause} ${whereClause} ORDER BY ${monthExpr}, mr.meter_element_id, mr.${primaryCol} DESC NULLS LAST`
        : aggSql;
    } else {
      // daily (default)
      const dateExpr = `DATE(mr.created_at AT TIME ZONE '${tz}')`;
      const dateCols  = `${dateExpr} as date`;
      aggSql = `SELECT ${dateCols}, ${meterCols}, ${groupCols} ${fromClause} ${whereClause} GROUP BY ${dateExpr}, mr.meter_id, mr.meter_element_id, m.name, me.element, me.name ORDER BY date`;
      groupSql = aggFn === 'MAX'
        ? `SELECT DISTINCT ON (${dateExpr}, mr.meter_element_id) ${dateCols}, ${meterCols}, ${rawCols}, mr.created_at as peaked_at ${fromClause} ${whereClause} ORDER BY ${dateExpr}, mr.meter_element_id, mr.${primaryCol} DESC NULLS LAST`
        : aggSql;
    }

    const aggResult = await execQuery(c.env, aggSql, aggParams);
    const groupResult = await execQuery(c.env, groupSql, aggParams);


    // Build a label map: { meter_element_id -> display label }
    const meter_element_labels: Record<number, string> = {};
    for (const row of groupResult.rows) {
      const eid = row.meter_element_id;
      if (eid && !meter_element_labels[eid]) {
        meter_element_labels[eid] = row.name || `Element ${eid}`;
      }
    }

    // Fetch units for selected columns from register table
    const column_units: Record<string, string> = {};
    if (selectedColumns.length > 0) {
      const placeholders = selectedColumns.map((_, i) => `$${i + 1}`).join(', ');
      const unitSql = `SELECT field_name, unit FROM register WHERE field_name IN (${placeholders})`;
      const unitResult = await execQuery(c.env, unitSql, selectedColumns);
      for (const row of unitResult.rows) {
        if (row.unit) column_units[row.field_name] = row.unit;
      }
    }

    return c.json({
      success: true,
      data: {
        card_id: card.dashboard_id,
        card_name: card.card_name,
        meter_element_id: meter_element_id,
        meter_selections: rawMs,
        time_frame: {
          type: card.time_frame_type || 'last_30_days',
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
        selected_columns: selectedColumns,
        column_units,
        meter_element_labels,
        aggregated_values: aggResult.rows[0] || {},
        grouped_data: groupResult.rows,
        grouping_type: card.grouping_type || 'daily',
        visualization_type: card.visualization_type,
      },
    });
  } catch (error: any) {
    logError('Error fetching aggregated data', error);
    return c.json({ success: false, message: 'Failed to fetch aggregated card data' }, 500);
  }
});

// POST /cards - Create a new dashboard card
app.post('/cards', requirePermission('dashboard:create'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const body = await c.req.json();
    console.log('[Dashboard] POST /cards - Request body:', {
      card_name: body.card_name,
      meter_selections: body.meter_selections,
    });

    // Validate meter belongs to tenant
    if (body.meter_id) {
      const meter = await findById(c.env, 'meter', 'meter_id', body.meter_id, tenantId);
      if (!meter) return c.json({ success: false, message: 'Meter not found', errors: [{ field: 'meter_id', message: 'Meter does not exist' }] }, 400);
    }

    // Validate meter element
    if (body.meter_element_id) {
      const me = await findById(c.env, 'meter_element', 'meter_element_id', body.meter_element_id);
      if (!me) return c.json({ success: false, message: 'Meter element not found', errors: [{ field: 'meter_element_id', message: 'Meter element does not exist' }] }, 400);
      if (Number(me.meter_id) !== Number(body.meter_id)) {
        return c.json({ success: false, message: 'Validation failed', errors: [{ field: 'meter_element_id', message: 'Meter element does not belong to the selected meter' }] }, 400);
      }
    }

    // Determine grid position � scan for first available space (left-to-right, top-to-bottom)
    const existingCards = await findAll(c.env, {
      table: 'dashboard',
      primaryKey: 'dashboard_id',
      tenantId,
      limit: 1000,
    });

    const GRID_COLS = 12;
    const newW = body.grid_w ?? 6;
    const newH = body.grid_h ?? 9;

    let gridX = 0;
    let gridY = 0;

    if (existingCards.rows.length > 0) {
      const layout = existingCards.rows.map((c: any) => ({
        x: c.grid_x ?? 0,
        y: c.grid_y ?? 0,
        w: c.grid_w ?? 4,
        h: c.grid_h ?? 8,
      }));

      outer: for (let tryY = 0; tryY <= 200; tryY++) {
        for (let tryX = 0; tryX <= GRID_COLS - newW; tryX++) {
          const overlaps = layout.some(item =>
            tryX < item.x + item.w && tryX + newW > item.x &&
            tryY < item.y + item.h && tryY + newH > item.y
          );
          if (!overlaps) {
            gridX = tryX;
            gridY = tryY;
            break outer;
          }
        }
      }
    }

    const cardData: Record<string, any> = {
      card_name: body.card_name,
      card_description: body.card_description || null,
      time_frame_type: body.time_frame_type,
      visualization_type: body.visualization_type,
      grouping_type: body.grouping_type || 'daily',
      aggregation_type: body.aggregation_type || 'none',
      custom_start_date: body.custom_start_date || null,
      custom_end_date: body.custom_end_date || null,
      meter_selections: body.meter_selections !== undefined
        ? (typeof body.meter_selections === 'string' ? body.meter_selections : JSON.stringify(body.meter_selections))
        : null,
      tenant_id: tenantId,
      created_by_users_id: user?.users_id,
      grid_x: gridX,
      grid_y: gridY,
      grid_w: newW,
      grid_h: newH,
    };

    const card = await create(c.env, 'dashboard', cardData);

    return c.json({
      success: true,
      data: {
        ...card,
        dashboard_id: card.dashboard_id,
      },
    }, 201);
  } catch (error: any) {
    logError('Error creating card', error);
    return c.json({ success: false, message: 'Failed to create dashboard card' }, 500);
  }
});

// PUT /cards/:id - Update a dashboard card
app.put('/cards/:id', requirePermission('dashboard:update'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const card = await findById(c.env, 'dashboard', 'dashboard_id', c.req.param('id'), tenantId);
    if (!card) return c.json({ success: false, message: 'Dashboard card not found' }, 404);

    const body = await c.req.json();

    console.log('[Dashboard] PUT /cards/:id - Request body:', {
      card_name: body.card_name,
      meter_selections: body.meter_selections,
    });

    const updateData: Record<string, any> = {};
    if (body.card_name !== undefined)          updateData.card_name = body.card_name;
    if (body.card_description !== undefined)   updateData.card_description = body.card_description;
    if (body.time_frame_type !== undefined)    updateData.time_frame_type = body.time_frame_type;
    if (body.visualization_type !== undefined) updateData.visualization_type = body.visualization_type;
    if (body.grouping_type !== undefined)      updateData.grouping_type = body.grouping_type;
    if (body.aggregation_type !== undefined)   updateData.aggregation_type = body.aggregation_type;
    if (body.custom_start_date !== undefined) updateData.custom_start_date = body.custom_start_date || null;
    if (body.custom_end_date !== undefined)   updateData.custom_end_date = body.custom_end_date || null;
    if (body.grid_x !== undefined)            updateData.grid_x = body.grid_x;
    if (body.grid_y !== undefined)            updateData.grid_y = body.grid_y;
    if (body.grid_w !== undefined)            updateData.grid_w = body.grid_w;
    if (body.grid_h !== undefined)            updateData.grid_h = body.grid_h;
    if (body.meter_selections !== undefined) {
      updateData.meter_selections = typeof body.meter_selections === 'string'
        ? body.meter_selections
        : JSON.stringify(body.meter_selections);
    }

    console.log('[Dashboard] PUT /cards/:id - updateData:', updateData);
    const updated = await update(c.env, 'dashboard', 'dashboard_id', c.req.param('id'), updateData);
    console.log('[Dashboard] PUT /cards/:id - Updated result:', updated);

    if (!updated) {
      return c.json({ success: false, message: 'Dashboard card not found or no changes applied' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...updated,
        dashboard_id: updated.dashboard_id,
        grid_x: updated.grid_x ?? 0,
        grid_y: updated.grid_y ?? 0,
        grid_w: updated.grid_w ?? 500,
        grid_h: updated.grid_h ?? 500,
        meter_selections: parseMeterSelections(updated.meter_selections),
      },
    });
  } catch (error: any) {
    logError('Error updating card', error);
    return c.json({ success: false, message: 'Failed to update dashboard card', error: error.message }, 500);
  }
});

// DELETE /cards/:id - Delete a dashboard card
app.delete('/cards/:id', requirePermission('dashboard:delete'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const card = await findById(c.env, 'dashboard', 'dashboard_id', c.req.param('id'), tenantId);
    if (!card) return c.json({ success: false, message: 'Dashboard card not found' }, 404);

    await remove(c.env, 'dashboard', 'dashboard_id', c.req.param('id'), tenantId);
    return c.json({ success: true, message: 'Dashboard card deleted successfully' });
  } catch (error: any) {
    logError('Error deleting card', error);
    return c.json({ success: false, message: 'Failed to delete dashboard card' }, 500);
  }
});

// GET /cards/:id/readings - Retrieve detailed meter readings for a card
app.get('/cards/:id/readings', requirePermission('dashboard:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const qs = c.req.query();
    const page = Math.max(1, parseInt(qs.page || '1') || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(qs.pageSize || '50') || 50));
    const sortBy = qs.sortBy || 'created_at';
    const sortOrder = (qs.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const card = await findById(c.env, 'dashboard', 'dashboard_id', c.req.param('id'), tenantId);
    if (!card) return c.json({ success: false, message: 'Dashboard card not found' }, 404);

    // Time frame
    const now = new Date();
    let startDate: Date;
    const timeFrameType = card.time_frame_type || 'last_month';
    if (timeFrameType === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (timeFrameType === 'this_month_to_date') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (timeFrameType === 'since_installation') {
      startDate = new Date('2000-01-01');
    } else if (timeFrameType === 'custom' && card.custom_start_date) {
      startDate = new Date(card.custom_start_date);
    } else {
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 1);
    }
    const endDate = (timeFrameType === 'custom' && card.custom_end_date) ? new Date(card.custom_end_date) : now;

    let rawCols = card.selected_columns;
    if (typeof rawCols === 'string') { try { rawCols = JSON.parse(rawCols); } catch { rawCols = []; } }
    const selectedColumns: string[] = (Array.isArray(rawCols) ? rawCols : [])
      .map((col: string) => columnNameMapping[col.toLowerCase()] || col.toLowerCase())
      .filter((col: string) => VALID_METER_READING_COLUMNS.has(col))
      .filter((col, idx, arr) => arr.indexOf(col) === idx);
    const columnsList = ['meter_reading_id', 'created_at', 'meter_id', 'meter_element_id', ...selectedColumns];
    const validSortColumns = ['meter_reading_id', 'created_at', 'updated_at', 'meter_id', 'meter_element_id', ...selectedColumns];
    const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'created_at';

    // Extract meter_id and meter_element_ids from meter_selections
    const readingsRawMs = parseMeterSelections(card.meter_selections);
    let readingsMeterIdVal: number | null = null;
    let readingsMeterElementIds: number[] = [];

    if (Array.isArray(readingsRawMs) && readingsRawMs.length > 0) {
      // Collect meter_id and meter_element_ids across all rows
      readingsRawMs.forEach((row: any) => {
        if (!readingsMeterIdVal && row.meter_id) {
          readingsMeterIdVal = row.meter_id;
        }
        if (row.meter_element_id) {
          readingsMeterElementIds.push(row.meter_element_id);
        }
      });
    }

    // Use first meter_element_id if available
    const readingsMeterElementId = readingsMeterElementIds.length > 0 ? readingsMeterElementIds[0] : null;

    console.log('[Dashboard] GET /cards/:id/readings - Extracted from meter_selections:', {
      meter_selections_raw: readingsRawMs,
      extracted_meter_id: readingsMeterIdVal,
      extracted_meter_element_ids: readingsMeterElementIds,
      using_meter_element_id: readingsMeterElementId,
    });

    // Build WHERE clause and params based on what's set in meter_selections
    // Always join with meter_element and meter to ensure only active meters are included
    let whereClause: string;
    let params: any[];
    const fromClause = 'FROM meter_reading mr JOIN meter_element me ON mr.meter_element_id = me.meter_element_id JOIN meter m ON me.meter_id = m.meter_id';

    // Build WHERE conditions based on what's in meter_selections
    let whereConditions = ['mr.tenant_id = $1', 'm.active = true'];
    params = [tenantId];
    let paramIndex = 2;

    if (readingsMeterIdVal) {
      whereConditions.push(`m.meter_id = $${paramIndex}`);
      params.push(readingsMeterIdVal);
      paramIndex++;
    }

    if (readingsMeterElementId) {
      whereConditions.push(`mr.meter_element_id = $${paramIndex}`);
      params.push(readingsMeterElementId);
      paramIndex++;
    }

    // Add date range
    whereConditions.push(`mr.created_at >= $${paramIndex}`);
    whereConditions.push(`mr.created_at <= $${paramIndex + 1}`);
    params.push(startDate, endDate);

    whereClause = 'WHERE ' + whereConditions.join(' AND ');

    // Count
    const countSql = `SELECT COUNT(*) as total ${fromClause} ${whereClause}`;
    const countResult = await execQuery(c.env, countSql, params);
    const total = parseInt(countResult.rows[0]?.total || '0');
    const totalPages = Math.ceil(total / pageSize);

    // Data - adjust column references for joined tables
    const adjustedColumnsList = columnsList.map((col: string) => col === 'meter_reading_id' ? 'mr.meter_reading_id' : col === 'created_at' ? 'mr.created_at' : col === 'meter_id' ? 'mr.meter_id' : col === 'meter_element_id' ? 'mr.meter_element_id' : `"mr"."${col}"`);
    const pageParams = [...params, pageSize, (page - 1) * pageSize];
    const paramCount = params.length;
    const sql = `SELECT ${adjustedColumnsList.join(', ')} ${fromClause} ${whereClause} ORDER BY ${safeSortBy === 'meter_reading_id' || safeSortBy === 'created_at' || safeSortBy === 'meter_id' || safeSortBy === 'meter_element_id' || safeSortBy === 'updated_at' ? (safeSortBy === 'updated_at' ? '"mr"."updated_at"' : `mr.${safeSortBy}`) : `"mr"."${safeSortBy}"`} ${sortOrder} LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    const result = await execQuery(c.env, sql, pageParams);

    return c.json({
      success: true,
      data: {
        items: result.rows,
        pagination: { page, pageSize, total, totalPages, hasMore: page < totalPages },
        metadata: {
          card_id: card.dashboard_id,
          card_name: card.card_name,
          meter_element_id: readingsMeterElementId,
          time_frame: { type: card.time_frame_type || 'last_30_days', start: startDate.toISOString(), end: endDate.toISOString() },
          selected_columns: selectedColumns,
          sort_by: safeSortBy,
          sort_order: sortOrder,
        },
      },
    });
  } catch (error: any) {
    logError('Error fetching meter readings', error);
    return c.json({ success: false, message: 'Failed to fetch meter readings' }, 500);
  }
});

// GET /cards/:id/readings/export - Export readings as CSV
app.get('/cards/:id/readings/export', requirePermission('dashboard:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const qs = c.req.query();
    const sortBy = qs.sortBy || 'created_at';
    const sortOrder = (qs.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const card = await findById(c.env, 'dashboard', 'dashboard_id', c.req.param('id'), tenantId);
    if (!card) return c.json({ success: false, message: 'Dashboard card not found' }, 404);

    const now = new Date();
    let startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 30);
    if (card.custom_start_date) startDate = new Date(card.custom_start_date);
    const endDate = card.custom_end_date ? new Date(card.custom_end_date) : now;

    let rawColsExp = card.selected_columns;
    if (typeof rawColsExp === 'string') { try { rawColsExp = JSON.parse(rawColsExp); } catch { rawColsExp = []; } }
    const selectedColumns: string[] = (Array.isArray(rawColsExp) ? rawColsExp : [])
      .map((col: string) => columnNameMapping[col.toLowerCase()] || col.toLowerCase())
      .filter((col: string) => VALID_METER_READING_COLUMNS.has(col))
      .filter((col, idx, arr) => arr.indexOf(col) === idx);
    const columnsList = ['meter_reading_id', 'created_at', 'meter_id', 'meter_element_id', ...selectedColumns];
    const validSortColumns = ['meter_reading_id', 'created_at', 'meter_id', 'meter_element_id', ...selectedColumns];
    const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'created_at';

    // Extract meter_id and meter_element_ids from meter_selections
    const exportRawMs = parseMeterSelections(card.meter_selections);
    let exportMeterIdVal: number | null = null;
    let exportMeterElementIds: number[] = [];

    if (Array.isArray(exportRawMs) && exportRawMs.length > 0) {
      // Collect meter_id and meter_element_ids across all rows
      exportRawMs.forEach((row: any) => {
        if (!exportMeterIdVal && row.meter_id) {
          exportMeterIdVal = row.meter_id;
        }
        if (row.meter_element_id) {
          exportMeterElementIds.push(row.meter_element_id);
        }
      });
    }

    // Use first meter_element_id if available
    const exportMeterElementId = exportMeterElementIds.length > 0 ? exportMeterElementIds[0] : null;

    console.log('[Dashboard] GET /cards/:id/readings/export - Extracted from meter_selections:', {
      meter_selections_raw: exportRawMs,
      extracted_meter_id: exportMeterIdVal,
      extracted_meter_element_ids: exportMeterElementIds,
      using_meter_element_id: exportMeterElementId,
    });

    // Build WHERE clause and params based on what's set in meter_selections
    // Always join with meter_element and meter to ensure only active meters are included
    let whereClause: string;
    let exportParams: any[];
    const fromClause = 'FROM meter_reading mr JOIN meter_element me ON mr.meter_element_id = me.meter_element_id JOIN meter m ON me.meter_id = m.meter_id';

    // Build WHERE conditions based on what's in meter_selections
    let whereConditions = ['mr.tenant_id = $1', 'm.active = true'];
    exportParams = [tenantId];
    let paramIndex = 2;

    if (exportMeterIdVal) {
      whereConditions.push(`m.meter_id = $${paramIndex}`);
      exportParams.push(exportMeterIdVal);
      paramIndex++;
    }

    if (exportMeterElementId) {
      whereConditions.push(`mr.meter_element_id = $${paramIndex}`);
      exportParams.push(exportMeterElementId);
      paramIndex++;
    }

    // Add date range
    whereConditions.push(`mr.created_at >= $${paramIndex}`);
    whereConditions.push(`mr.created_at <= $${paramIndex + 1}`);
    exportParams.push(startDate, endDate);

    whereClause = 'WHERE ' + whereConditions.join(' AND ');

    // Adjust column references for joined tables
    const adjustedExportColumnsList = columnsList.map((col: string) => col === 'meter_reading_id' ? 'mr.meter_reading_id' : col === 'created_at' ? 'mr.created_at' : col === 'meter_id' ? 'mr.meter_id' : col === 'meter_element_id' ? 'mr.meter_element_id' : `"mr"."${col}"`);
    const sql = `SELECT ${adjustedExportColumnsList.join(', ')} ${fromClause} ${whereClause} ORDER BY ${safeSortBy === 'meter_reading_id' || safeSortBy === 'created_at' || safeSortBy === 'meter_id' || safeSortBy === 'meter_element_id' ? `mr.${safeSortBy}` : `"mr"."${safeSortBy}"`} ${sortOrder}`;
    const result = await execQuery(c.env, sql, exportParams);

    // Build CSV
    const escapeCSV = (v: any) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = columnsList.map((col) => col.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
    const metadata = [
      ['Meter Reading Export'],
      ['Card Name', card.card_name],
      ['Meter Element ID', exportMeterElementId],
      ['Time Frame', `${startDate.toISOString()} to ${endDate.toISOString()}`],
      ['Export Date', new Date().toISOString()],
      ['Total Records', result.rows.length],
      [],
    ];

    const csvRows = [
      ...metadata.map((row: any[]) => row.map(escapeCSV).join(',')),
      headers.join(','),
      ...result.rows.map((row: any) => columnsList.map((col) => escapeCSV(row[col])).join(',')),
    ];

    const csv = csvRows.join('\n');
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${(card.card_name || 'export').replace(/\s+/g, '_')}_${timestamp}.csv`;

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error: any) {
    logError('Error exporting meter readings', error);
    return c.json({ success: false, message: 'Failed to export meter readings' }, 500);
  }
});

// GET /meters - Retrieve all meters for the tenant
app.get('/meters', authenticateToken, async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const result = await execQuery(
      c.env,
      'SELECT meter_id as id, name FROM meter WHERE tenant_id = $1 AND active = true ORDER BY name ASC',
      [tenantId]
    );

    return c.json({ success: true, data: result.rows });
  } catch (error: any) {
    logError('Error fetching meters', error);
    return c.json({ success: false, message: 'Failed to fetch meters' }, 500);
  }
});

// GET /meters/:meterId/elements - Retrieve meter elements
app.get('/meters/:meterId/elements', authenticateToken, async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const meterId = parseInt(c.req.param('meterId'));
    if (isNaN(meterId)) return c.json({ success: false, message: 'Invalid meter ID' }, 400);

    console.log('[DASHBOARD] GET /meters/:meterId/elements - meterId:', meterId, 'tenantId from context:', tenantId, 'type:', typeof tenantId);

    // Verify meter belongs to tenant
    const meterResult = await execQuery(c.env, 'SELECT meter_id, tenant_id FROM meter WHERE meter_id = $1', [meterId]);
    if (meterResult.rows.length === 0) return c.json({ success: false, message: 'Meter not found' }, 404);

    console.log('[DASHBOARD] Meter found - meterResult.tenant_id:', meterResult.rows[0].tenant_id, 'type:', typeof meterResult.rows[0].tenant_id, 'user tenantId:', tenantId, 'type:', typeof tenantId);

    if (Number(meterResult.rows[0].tenant_id) !== Number(tenantId)) return c.json({ success: false, message: 'You do not have permission to access this meter' }, 403);

    const result = await execQuery(
      c.env,
      'SELECT meter_element_id, meter_id, element, name FROM meter_element WHERE meter_id = $1 AND tenant_id = $2 ORDER BY element ASC',
      [meterId, tenantId]
    );

    return c.json({ success: true, data: result.rows });
  } catch (error: any) {
    logError('Error fetching meter elements', error);
    return c.json({ success: false, message: 'Failed to fetch meter elements' }, 500);
  }
});

// GET /anomalies - Recent kW spikes flagged by the quality engine (migration 054)
app.get('/anomalies', requirePermission('dashboard:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);

    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '10') || 10));

    const result = await execQuery(
      c.env,
      `SELECT a.meter_reading_anomaly_id, a.meter_id, a.meter_element_id, a.metric,
              a.reading_at, a.actual_value, a.expected_value, a.deviation, a.z_score, a.detected_at,
              m.name AS meter_name, me.element AS element_code, me.name AS element_name
       FROM meter_reading_anomaly a
       JOIN meter m ON m.meter_id = a.meter_id
       LEFT JOIN meter_element me ON me.meter_element_id = a.meter_element_id
       WHERE a.tenant_id = $1
       ORDER BY a.detected_at DESC
       LIMIT $2`,
      [tenantId, limit]
    );

    return c.json({ success: true, data: result.rows });
  } catch (error: any) {
    logError('Error fetching anomalies', error);
    return c.json({ success: false, message: 'Failed to fetch anomalies' }, 500);
  }
});

// Mapping of register names to actual meter_reading column names
const columnNameMapping: Record<string, string> = {
  // Energy totals (old -> new mapping support backwards compatibility)
  'kwh': 'kwh',
  'kvarh': 'kvarh',
  'kvah': 'kvah',
  'active_energy': 'kwh',
  'reactive_energy': 'kvarh',
  'apparent_energy': 'kvah',
  'active_energy_export': 'mwh',
  'reactive_energy_export': 'kvarh_export',
  'apparent_energy_export': 'kvah_export',
  'mwh': 'mwh',
  'kvarh_export': 'kvarh_export',
  'kvah_export': 'kvah_export',
  // Power
  'kw': 'kw',
  'kvar': 'kvar',
  'kva': 'kva',
  'total_active_power': 'kw',
  'total_reactive_power': 'kvar',
  'total_apparent_power': 'kva',
  'power': 'kw',
  'reactive_power': 'kvar',
  'apparent_power': 'kva',
  // Phase power
  'phase_a_power': 'phase_kw_a',
  'phase_b_power': 'phase_kw_b',
  'phase_c_power': 'phase_kw_c',
  'power_phase_a': 'phase_kw_a',
  'power_phase_b': 'phase_kw_b',
  'power_phase_c': 'phase_kw_c',
  'phase_kw_a': 'phase_kw_a',
  'phase_kw_b': 'phase_kw_b',
  'phase_kw_c': 'phase_kw_c',
  'apparent_power_phase_a': 'phase_kva_a',
  'apparent_power_phase_b': 'phase_kva_b',
  'apparent_power_phase_c': 'phase_kva_c',
  'phase_kva_a': 'phase_kva_a',
  'phase_kva_b': 'phase_kva_b',
  'phase_kva_c': 'phase_kva_c',
  'reactive_power_phase_a': 'phase_kvar_a',
  'reactive_power_phase_b': 'phase_kvar_b',
  'reactive_power_phase_c': 'phase_kvar_c',
  'phase_kvar_a': 'phase_kvar_a',
  'phase_kvar_b': 'phase_kvar_b',
  'phase_kvar_c': 'phase_kvar_c',
  // Current
  'ia': 'phase_amperage_a',
  'ib': 'phase_amperage_b',
  'ic': 'phase_amperage_c',
  'phase_a_current': 'phase_amperage_a',
  'phase_b_current': 'phase_amperage_b',
  'phase_c_current': 'phase_amperage_c',
  'current': 'amperage',
  'current_line_a': 'phase_amperage_a',
  'current_line_b': 'phase_amperage_b',
  'current_line_c': 'phase_amperage_c',
  'amperage': 'amperage',
  'phase_amperage_a': 'phase_amperage_a',
  'phase_amperage_b': 'phase_amperage_b',
  'phase_amperage_c': 'phase_amperage_c',
  // Voltage
  'va': 'voltage_a_n',
  'vb': 'voltage_b_n',
  'vc': 'voltage_c_n',
  'vab': 'voltage_a_b',
  'vbc': 'voltage_b_c',
  'vca': 'voltage_c_a',
  'phase_a_voltage': 'voltage_a_n',
  'phase_b_voltage': 'voltage_b_n',
  'phase_c_voltage': 'voltage_c_n',
  'voltage_a_n': 'voltage_a_n',
  'voltage_b_n': 'voltage_b_n',
  'voltage_c_n': 'voltage_c_n',
  'voltage_a_b': 'voltage_a_b',
  'voltage_b_c': 'voltage_b_c',
  'voltage_c_a': 'voltage_c_a',
  'voltage_p_n': 'voltage_p_n',
  'voltage_p_p': 'voltage_p_p',
  // Power factor
  'pf': 'pf',
  'power_factor': 'pf',
  'power_factor_phase_a': 'pf_a',
  'power_factor_phase_b': 'pf_b',
  'power_factor_phase_c': 'pf_c',
  'pf_a': 'pf_a',
  'pf_b': 'pf_b',
  'pf_c': 'pf_c',
  // Other
  'hz': 'frequency',
  'frequency': 'frequency',
  'maximum_demand_real': 'peak_kw',
  'peak_kw': 'peak_kw',
  'voltage_thd': 'total_thdv',
  'voltage_thd_phase_a': 'phase_thdv_a',
  'voltage_thd_phase_b': 'phase_thdv_b',
  'voltage_thd_phase_c': 'phase_thdv_c',
  'total_thdv': 'total_thdv',
  'phase_thdv_a': 'phase_thdv_a',
  'phase_thdv_b': 'phase_thdv_b',
  'phase_thdv_c': 'phase_thdv_c',
};

// GET /power-columns - Get all registers associated with a device via meterId
app.get('/power-columns', requirePermission('dashboard:read'), async (c) => {
  try {
    const meterId = c.req.query('deviceId');
    if (!meterId) {
      return c.json({ success: false, message: 'deviceId parameter is required' }, 400);
    }

    const sql = `
      SELECT DISTINCT r.name
      FROM register r
      JOIN device_register dr ON r.register_id = dr.register_id
      JOIN meter m ON m.device_id = dr.device_id
      WHERE m.meter_id = $1
      ORDER BY r.name ASC
    `;

    const result = await execQuery(c.env, sql, [meterId]);
    const columns = result.rows.map((r: any) => {
      const label = r.name.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return { name: r.name, label, type: 'numeric' };
    });

    return c.json({
      success: true,
      data: columns,
      meta: { count: columns.length },
    });
  } catch (error: any) {
    logError('Error fetching power columns', error);
    return c.json({ success: false, message: 'Failed to fetch power columns' }, 500);
  }
});

// GET /power-columns/cache/invalidate
app.get('/power-columns/cache/invalidate', requirePermission('dashboard:admin'), (c) => {
  return c.json({ success: true, message: 'Power columns cache invalidated (no-op on worker)' });
});

// GET /power-columns/cache/stats
app.get('/power-columns/cache/stats', requirePermission('dashboard:read'), (c) => {
  return c.json({ success: true, data: { cached: false, message: 'No cache on worker deployment' } });
});

// GET /total-active-energy - Sum of active_energy from latest reading of each active meter element
/*
app.get('/total-active-energy', requirePermission('dashboard:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);
    }

    const sql = `
      SELECT COALESCE(SUM(latest_readings.active_energy), 0) AS total_active_energy
      FROM (
        SELECT DISTINCT ON (mr.meter_element_id)
          mr.active_energy
        FROM meter m
        JOIN meter_element me ON me.meter_id = m.meter_id
        JOIN meter_reading mr
          ON mr.meter_element_id = me.meter_element_id
          AND mr.tenant_id = $1
        WHERE m.tenant_id = $1
          AND m.active = true
        ORDER BY mr.meter_element_id, mr.created_at DESC
      ) AS latest_readings
    `;

    const result = await execQuery(c.env, sql, [tenantId]);
    const totalActiveEnergy = parseFloat(result.rows?.[0]?.total_active_energy || '0');

    return c.json({
      success: true,
      data: {
        total_active_energy: totalActiveEnergy,
      },
    });
  } catch (error: any) {
    logError('Error fetching total active energy', error);
    return c.json({ success: false, message: 'Failed to fetch total active energy' }, 500);
  }
});
*/

// GET /total-power - Sum of power from latest reading of each active meter element
/*
app.get('/total-power', requirePermission('dashboard:read'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ success: false, message: 'User must have a valid tenant_id' }, 400);
    }

    const sql = `
      SELECT COALESCE(SUM(latest_readings.power), 0) AS total_power
      FROM (
        SELECT DISTINCT ON (mr.meter_element_id)
          mr.power
        FROM meter m
        JOIN meter_element me ON me.meter_id = m.meter_id
        JOIN meter_reading mr
          ON mr.meter_element_id = me.meter_element_id
          AND mr.tenant_id = $1
        WHERE m.tenant_id = $1
          AND m.active = true
        ORDER BY mr.meter_element_id, mr.created_at DESC
      ) AS latest_readings
    `;

    const result = await execQuery(c.env, sql, [tenantId]);
    const totalPower = parseFloat(result.rows?.[0]?.total_power || '0');

    return c.json({
      success: true,
      data: {
        total_power: totalPower,
      },
    });
  } catch (error: any) {
    logError('Error fetching total power', error);
    return c.json({ success: false, message: 'Failed to fetch total power' }, 500);
  }
});
*/

export default app;
