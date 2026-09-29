import { Hono } from 'hono';
import { Env, execQuery } from '../db';

import { authenticateToken, AuthVariables } from '../middleware';
import { logError } from '../errorHandler';
import { scoreEntities, extractDocumentText } from '@meterit/framework-backend/api/base/aiSearch';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

function validateSearchBody(body: any): { error: { code: string; message: string } } | null {
  const { query: searchQuery, limit = 20, offset = 0 } = body;
  if (!searchQuery || typeof searchQuery !== 'string' || searchQuery.trim().length === 0) {
    return { error: { code: 'INVALID_QUERY', message: 'Query is required and must be a non-empty string' } };
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return { error: { code: 'INVALID_LIMIT', message: 'Limit must be a positive integer' } };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { error: { code: 'INVALID_OFFSET', message: 'Offset must be a non-negative integer' } };
  }
  return null;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const invalid = validateSearchBody(body);
    if (invalid) return c.json({ success: false, error: invalid.error }, 400);
    const { query: searchQuery, limit = 20, offset = 0 } = body;
    const tenantId = c.get('tenantId');

    const startTime = Date.now();

    const devicesResult = await execQuery(c.env,
      `SELECT device_id as id, tenant_id as "tenantId", name, type, location, status, metadata
       FROM public.device WHERE tenant_id = $1 ORDER BY name ASC`, [tenantId]);
    const devices: any[] = devicesResult.rows || [];

    const readingsByDevice = new Map<number, any[]>();
    if (devices.length > 0) {
      const metersResult = await execQuery(c.env,
        `SELECT meter_id as id, tenant_id as "tenantId", device_id as "deviceId", name, unit, type
         FROM public.meter WHERE tenant_id = $1`, [tenantId]);
      const meters: any[] = metersResult.rows || [];

      const readingsResult = await execQuery(c.env,
        `SELECT mr.meter_id as "meterId", mr.value, mr.timestamp, mr.quality
         FROM public.meter_reading mr WHERE mr.tenant_id = $1 AND mr.timestamp >= NOW() - INTERVAL '30 days'
         ORDER BY mr.meter_id, mr.timestamp DESC`, [tenantId]);
      const readings: any[] = readingsResult.rows || [];

      devices.forEach((device) => {
        const deviceReadings = readings.filter((r) => {
          const meter = meters.find((m) => m.id === r.meterId);
          return meter && meter.deviceId === device.id;
        });
        readingsByDevice.set(device.id, deviceReadings || []);
      });
    }

    const scoredDevices = scoreEntities(devices, searchQuery, [
      { key: 'name', weight: 5, exactWeight: 10 },
      { key: 'type', weight: 3 },
      { key: 'location', weight: 2 },
      { key: 'status', weight: 1 },
    ]);

    const deviceResults = scoredDevices.map(({ row: device, score }) => {
      const deviceReadings = readingsByDevice.get(device.id) || [];
      const latestReading = deviceReadings.length > 0 ? deviceReadings[0] : { value: 0, timestamp: new Date().toISOString() };
      return {
        id: device.id, name: device.name, type: 'device',
        location: device.location || 'Unknown', currentConsumption: latestReading.value || 0,
        unit: 'kWh', status: device.status || 'unknown',
        relevanceScore: Math.min(score / 10, 1.0),
        lastReading: { value: latestReading.value || 0, timestamp: latestReading.timestamp || new Date().toISOString() },
      };
    });

    // tenant_document: admin-uploaded files (cutsheets, manuals, etc.), scoped
    // to this tenant. File type = file_type (mime type); no doc_type column here
    // (that only exists on TBWC's public.document table).
    const docsResult = await execQuery(c.env,
      `SELECT tenant_document_id as id, description, file_name as "fileName", file_type as "fileType", file_size as "fileSize"
       FROM tenant_document WHERE tenant_id = $1`, [tenantId]);
    const tenantDocs: any[] = docsResult.rows || [];
    const scoredDocs = scoreEntities(tenantDocs, searchQuery, [
      { key: 'fileName', weight: 5, exactWeight: 10 },
      { key: 'fileType', weight: 2 },
      { key: 'description', weight: 2 },
    ]);
    const docResults = scoredDocs.map(({ row: doc, score }) => ({
      id: doc.id, name: doc.fileName, type: 'document',
      mimeType: doc.fileType, fileSize: doc.fileSize, description: doc.description,
      relevanceScore: Math.min(score / 10, 1.0),
    }));

    const combined = [...deviceResults, ...docResults].sort((a, b) => b.relevanceScore - a.relevanceScore);
    const results = combined.slice(offset, offset + limit);

    return c.json({
      success: true,
      data: {
        results,
        total: combined.length,
        clarifications: [],
        executionTime: Date.now() - startTime,
        // Content search covers ALL of this tenant's documents, not just these
        // name/type matches, so offer it whenever any documents exist.
        documentsTotal: tenantDocs.length,
      },
    });
  } catch (error: any) {
    console.error('[AI_SEARCH] Error:', error.message);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An error occurred while processing your search' } }, 500);
  }
});

const MAX_CONTENT_DOCS = 100;
const MAX_CONTENT_FILE_SIZE = 20 * 1024 * 1024;

// Slow, opt-in pass: base64-decodes each of this tenant's files (already
// inline in the row — no network fetch needed) and text-extracts them.
app.post('/content', async (c) => {
  try {
    const body = await c.req.json();
    const invalid = validateSearchBody(body);
    if (invalid) return c.json({ success: false, error: invalid.error }, 400);
    const { query: searchQuery, limit = 20, offset = 0 } = body;
    const tenantId = c.get('tenantId');

    const startTime = Date.now();

    const docsResult = await execQuery(c.env,
      `SELECT tenant_document_id as id, file_name as "fileName", file_type as "fileType", file_size as "fileSize", file_data as "fileData"
       FROM tenant_document
       WHERE tenant_id = $1 AND (file_size IS NULL OR file_size <= $2)
       ORDER BY created_at DESC
       LIMIT $3`, [tenantId, MAX_CONTENT_FILE_SIZE, MAX_CONTENT_DOCS + 1]);
    const rows: any[] = docsResult.rows || [];
    const truncated = rows.length > MAX_CONTENT_DOCS;
    const scanRows = rows.slice(0, MAX_CONTENT_DOCS);

    const q = searchQuery.trim().toLowerCase();
    const matches: any[] = [];
    for (const row of scanRows) {
      if (!row.fileData) continue;
      const bytes = base64ToArrayBuffer(row.fileData);
      const text = await extractDocumentText(bytes, row.fileType, row.fileName);
      if (!text) continue;
      const lower = text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx === -1) continue;
      const occurrences = lower.split(q).length - 1;
      matches.push({
        id: row.id, name: row.fileName, type: 'document',
        mimeType: row.fileType, fileSize: row.fileSize,
        snippet: text.slice(Math.max(0, idx - 60), idx + q.length + 60).trim(),
        relevanceScore: Math.min(occurrences / 5, 1.0),
      });
    }
    matches.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const results = matches.slice(offset, offset + limit);

    return c.json({
      success: true,
      data: { results, total: matches.length, scanned: scanRows.length, truncated, executionTime: Date.now() - startTime },
    });
  } catch (error: any) {
    logError('[AI_SEARCH_CONTENT]', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An error occurred while searching document contents' } }, 500);
  }
});

export default app;
