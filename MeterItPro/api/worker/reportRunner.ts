/**
 * Report execution for Cloudflare Workers.
 *
 * Ports the MCP ReportExecutor + EmailSender logic to run inside a Worker:
 * - Queries are done via the Worker's `query()` helper (Hyperdrive / pg).
 * - Email is sent via the Resend HTTP API (no TCP / nodemailer required).
 *
 * Required env vars (set via `npx wrangler secret put`):
 *   RESEND_API_KEY  � API key from resend.com (free tier: 3,000 emails/month)
 *   RESEND_FROM     � "From" address, e.g. "MeterItPro <noreply@meteritpro.com>"
 */

import { Env, execQuery } from './db';
import { matchesCronSchedule } from './cronMatcher';
import { getDateRange, queryConsumption, queryDemand, queryVirtualConsumption, queryVirtualDemand, type TimePeriod } from './meterQueryHelpers';

// --- Types --------------------------------------------------------------------

interface Report {
  report_id: number;
  name: string;
  type: string;
  tenant_id: number | null;
  recipients: { from?: string | null; to: string[] };
  meter_selections: any[] | null;
  time_frame: string | null;
  visualization_type: string | null;
  grouping_type: string | null;
  attach_as: string | null;
}

interface MeterSelection {
  id: string;
  meter_id: number | null;
  meter_element_ids: number[] | null;
  register_field_names: string[];
}

interface MeterElementPair {
  meter_id: string;
  meter_element_id: string;
}

interface ReportData {
  type: string;
  generatedAt: string;
  period?: string;
  recordCount?: number;
  meterCount?: number;
  dayCount?: number;
  data: Record<string, any>[];
}

// --- Helpers ------------------------------------------------------------------

function parseMeterSelections(raw: any): MeterSelection[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as MeterSelection[];
  return null;
}

interface SplitSelections {
  physicalPairs: MeterElementPair[];
  virtualMeterIds: number[];
}

async function splitMeterSelections(env: Env, report: Report): Promise<SplitSelections> {
  const selections = parseMeterSelections(report.meter_selections);

  if (!selections || selections.length === 0) {
    // No explicit selections — return all physical pairs, no virtual
    const all = await execQuery(
      env,
      `SELECT m.meter_id, me.meter_element_id
       FROM meter m
       JOIN meter_element me ON me.meter_id = m.meter_id
       WHERE m.active = true AND m.meter_id NOT IN (SELECT DISTINCT meter_id FROM meter_virtual)`
    );
    return { physicalPairs: all.rows.map(r => ({ meter_id: String(r.meter_id), meter_element_id: String(r.meter_element_id) })), virtualMeterIds: [] };
  }

  const meterIds = [...new Set(selections.map(s => Number(s.meter_id)).filter(id => !isNaN(id) && id > 0))];
  const virtualIdRows = meterIds.length > 0
    ? (await execQuery(env, `SELECT DISTINCT meter_id FROM meter_virtual WHERE meter_id = ANY($1)`, [meterIds])).rows
    : [];
  const virtualMeterIdSet = new Set(virtualIdRows.map((r: any) => Number(r.meter_id)));

  const physicalPairs: MeterElementPair[] = [];
  const virtualMeterIds: number[] = [];

  for (const sel of selections) {
    if (!sel.meter_id) continue;
    const meterId = Number(sel.meter_id);

    if (virtualMeterIdSet.has(meterId)) {
      virtualMeterIds.push(meterId);
    } else {
      if (sel.meter_element_ids && sel.meter_element_ids.length > 0) {
        for (const elId of sel.meter_element_ids) {
          physicalPairs.push({ meter_id: String(meterId), meter_element_id: String(elId) });
        }
      } else {
        const elements = await execQuery(env, `SELECT meter_element_id FROM meter_element WHERE meter_id = $1`, [meterId]);
        for (const el of elements.rows) {
          physicalPairs.push({ meter_id: String(meterId), meter_element_id: String(el.meter_element_id) });
        }
      }
    }
  }

  return { physicalPairs, virtualMeterIds };
}

async function getMeterElementPairs(env: Env, report: Report): Promise<MeterElementPair[]> {
  const { physicalPairs } = await splitMeterSelections(env, report);
  return physicalPairs;
}

function buildPairFilter(
  pairs: MeterElementPair[],
  startParamIdx: number
): { sql: string; params: any[] } | null {
  if (pairs.length === 0) return null;
  const clauses = pairs.map((_, i) =>
    `(r.meter_id = $${startParamIdx + i * 2} AND r.meter_element_id = $${startParamIdx + i * 2 + 1})`
  );
  const params = pairs.flatMap(({ meter_id, meter_element_id }) => [meter_id, meter_element_id]);
  return { sql: `(${clauses.join(' OR ')})`, params };
}

function getRegisterFieldNames(report: Report): string[] | null {
  const selections = parseMeterSelections(report.meter_selections);
  if (!selections || selections.length === 0) return null;
  const names = selections.flatMap(s => s.register_field_names ?? []);
  return names.length > 0 ? [...new Set(names)] : null;
}

const INTERNAL_IDS = new Set(['meter_reading_id', 'meter_id', 'meter_element_id', 'tenant_id', 'device_id', 'reading_id']);
const IDENTIFIERS = new Set(['meter_name', 'element', 'created_at', 'date']);

function filterColumns(rows: Record<string, any>[], allowedFields: string[] | null): Record<string, any>[] {
  if (!allowedFields) {
    return rows.map(row =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !INTERNAL_IDS.has(k)))
    );
  }
  const allowed = new Set([...IDENTIFIERS, ...allowedFields]);
  return rows.map(row =>
    Object.fromEntries(Object.entries(row).filter(([k]) => allowed.has(k)))
  );
}

function formatValue(value: any): string {
  if (value === null || value === undefined) return '-';
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

// --- Date range helper --------------------------------------------------------

function getReportDateRange(config: Record<string, any>): { startDate: Date; endDate: Date } {
  const timeFrame = config.time_frame || 'monthly';
  return getDateRange(timeFrame, config.custom_start_date, config.custom_end_date);
}

// --- Chart series data (same queries as the dashboard) ------------------------

interface ChartSeriesData {
  labels: string[];
  series: Array<{ name: string; data: number[] }>;
  unit: string;
  timePeriod: string;
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function buildTimeLabels(timePeriod: TimePeriod, startDate: Date, endDate: Date): string[] {
  if (timePeriod === 'today') {
    return Array.from({ length: 24 }, (_, h) =>
      h === 0 ? '12AM' : h < 12 ? `${h}AM` : h === 12 ? '12PM' : `${h - 12}PM`
    );
  }
  if (timePeriod === 'yearly') {
    return MONTH_NAMES.slice();
  }
  // weekly / monthly � one label per day
  const labels: string[] = [];
  const cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    labels.push(cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    cursor.setDate(cursor.getDate() + 1);
  }
  return labels;
}

function buildLabelKeys(timePeriod: TimePeriod, startDate: Date, endDate: Date): string[] {
  if (timePeriod === 'today') return Array.from({ length: 24 }, (_, h) => String(h));
  if (timePeriod === 'yearly') return Array.from({ length: 12 }, (_, i) => String(i + 1));
  const keys: string[] = [];
  const cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    keys.push([
      cursor.getFullYear(),
      String(cursor.getMonth() + 1).padStart(2, '0'),
      String(cursor.getDate()).padStart(2, '0'),
    ].join('-'));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

async function fetchChartSeriesData(env: Env, report: Report, tenantIdFallback?: number | null): Promise<ChartSeriesData> {
  const isDemand = report.type === 'demand';
  const timeFrame = report.time_frame || 'monthly';
  const timePeriod = (['today', 'weekly', 'monthly', 'yearly'].includes(timeFrame) ? timeFrame : 'monthly') as TimePeriod;
  const { startDate, endDate } = getReportDateRange(report);

  const tenantId: number | null = report.tenant_id ?? tenantIdFallback ?? null;
  if (!tenantId) return { labels: [], series: [], unit: isDemand ? 'kW' : 'kWh', timePeriod };

  const { physicalPairs, virtualMeterIds } = await splitMeterSelections(env, report);
  if (physicalPairs.length === 0 && virtualMeterIds.length === 0) {
    return { labels: [], series: [], unit: isDemand ? 'kW' : 'kWh', timePeriod };
  }

  const labels = buildTimeLabels(timePeriod, startDate, endDate);
  const keys   = buildLabelKeys(timePeriod, startDate, endDate);

  // Physical meters — one series per element
  const elementIds = [...new Set(physicalPairs.map(p => Number(p.meter_element_id)))];
  const nameRows = elementIds.length > 0
    ? (await execQuery(
        env,
        `SELECT me.meter_element_id,
               CONCAT(COALESCE(TRIM(m.name)), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, '?')) AS meter_name
         FROM meter_element me
         JOIN meter m ON me.meter_id = m.meter_id
         WHERE me.meter_element_id = ANY($1)`,
        [elementIds]
      )).rows
    : [];
  const nameMap = new Map(nameRows.map((r: any) => [String(r.meter_element_id), String(r.meter_name)]));

  const physicalSeries = await Promise.all(physicalPairs.map(async ({ meter_id, meter_element_id }) => {
    const params = {
      tenantId: Number(tenantId),
      meterId: Number(meter_id),
      meterElementId: Number(meter_element_id),
      timePeriod,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    };
    const raw: Array<{ label_key: string | number; power?: number; calculated_kwh?: number }> = isDemand
      ? await queryDemand(env, params)
      : await queryConsumption(env, params);

    const lookup = new Map<string, number>(
      raw.map((r): [string, number] => [String(r.label_key), isDemand ? Number(r.power) : Number(r.calculated_kwh)])
    );
    return {
      name: nameMap.get(String(meter_element_id)) ?? `Element ${meter_element_id}`,
      data: keys.map(k => lookup.get(k) ?? 0),
    };
  }));

  // Virtual meters — one aggregated series per virtual meter
  const virtualNameRows = virtualMeterIds.length > 0
    ? (await execQuery(env, `SELECT meter_id, name FROM meter WHERE meter_id = ANY($1)`, [virtualMeterIds])).rows
    : [];
  const virtualNameMap = new Map(virtualNameRows.map((r: any) => [Number(r.meter_id), r.name as string]));

  const virtualSeries = await Promise.all(virtualMeterIds.map(async (meterId) => {
    const params = {
      tenantId: Number(tenantId),
      meterId,
      timePeriod,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    };
    const raw: Array<{ label_key: string | number; power?: number; calculated_kwh?: number }> = isDemand
      ? await queryVirtualDemand(env, params)
      : await queryVirtualConsumption(env, params);

    const lookup = new Map<string, number>(
      raw.map((r): [string, number] => [String(r.label_key), isDemand ? Number(r.power) : Number(r.calculated_kwh)])
    );
    return {
      name: virtualNameMap.get(meterId) ?? `Virtual Meter ${meterId}`,
      data: keys.map(k => lookup.get(k) ?? 0),
    };
  }));

  return { labels, series: [...physicalSeries, ...virtualSeries], unit: isDemand ? 'kW' : 'kWh', timePeriod };
}

// --- Report data generators ---------------------------------------------------

async function generateMeterReadingsReport(env: Env, report: Report): Promise<ReportData> {
  const allowedFields = getRegisterFieldNames(report);
  const pairs = await getMeterElementPairs(env, report);
  const pairFilter = pairs.length > 0 ? buildPairFilter(pairs, 1) : null;

  const whereClause = [`r.created_at >= NOW() - INTERVAL '24 hours'`, pairFilter?.sql]
    .filter(Boolean).join(' AND ');

  // Build explicit column list from register_field_names to avoid selecting r.*
  // Sanitize each name to prevent injection (only allow word characters)
  let registerSelect: string;
  if (allowedFields && allowedFields.length > 0) {
    const safe = allowedFields.filter(f => /^\w+$/.test(f));
    registerSelect = ['r.created_at', ...safe.map(f => `r.${f}`)].join(',\n       ');
  } else {
    // No specific fields configured � exclude only internal ID columns
    registerSelect = 'r.created_at, r.kwh, r.kw, r.power_factor, r.voltage, r.current';
  }

  const result = await execQuery(
    env,
    `SELECT
       CONCAT(COALESCE(TRIM(m.name)), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, '?'))   AS meter_name,
       ${registerSelect}
     FROM meter_reading r
     JOIN meter m ON m.meter_id = r.meter_id
     JOIN meter_element me ON me.meter_element_id = r.meter_element_id
     WHERE ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT 2000`,
    pairFilter?.params ?? []
  );

  return { type: 'meter_readings', generatedAt: new Date().toISOString(), period: 'Last 24 hours', recordCount: result.rows.length, data: result.rows };
}

async function generateUsageSummaryReport(env: Env, report: Report): Promise<ReportData> {
  const { physicalPairs, virtualMeterIds } = await splitMeterSelections(env, report);
  const pairFilter = physicalPairs.length > 0 ? buildPairFilter(physicalPairs, 1) : null;

  const physicalRows = pairFilter
    ? (await execQuery(
        env,
        `SELECT
           CONCAT(COALESCE(TRIM(m.name)), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, '?')) AS meter_name,
           COUNT(*)                                                             AS reading_count,
           ROUND(SUM(r.kwh)::numeric, 2)                                       AS total_kwh,
           ROUND(AVG(r.kw)::numeric, 2)                                        AS avg_kw,
           ROUND(MAX(r.kw)::numeric, 2)                                        AS peak_kw,
           ROUND(MIN(r.kw)::numeric, 2)                                        AS min_kw,
           ROUND(AVG(r.power_factor)::numeric, 4)                              AS avg_pf,
           MAX(r.created_at)                                                    AS last_reading_at
         FROM meter_reading r
         JOIN meter m ON m.meter_id = r.meter_id
         JOIN meter_element me ON me.meter_element_id = r.meter_element_id
         WHERE r.created_at >= NOW() - INTERVAL '30 days' AND ${pairFilter.sql}
         GROUP BY m.meter_id, m.name, me.meter_element_id, me.element, me.name
         ORDER BY m.name, element`,
        pairFilter.params
      )).rows
    : physicalPairs.length === 0 && virtualMeterIds.length === 0
      // No selections at all — fetch all physical meters
      ? (await execQuery(
          env,
          `SELECT
             CONCAT(COALESCE(TRIM(m.name)), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, '?')) AS meter_name,
             COUNT(*)                                                             AS reading_count,
             ROUND(SUM(r.kwh)::numeric, 2)                                       AS total_kwh,
             ROUND(AVG(r.kw)::numeric, 2)                                        AS avg_kw,
             ROUND(MAX(r.kw)::numeric, 2)                                        AS peak_kw,
             ROUND(MIN(r.kw)::numeric, 2)                                        AS min_kw,
             ROUND(AVG(r.power_factor)::numeric, 4)                              AS avg_pf,
             MAX(r.created_at)                                                    AS last_reading_at
           FROM meter_reading r
           JOIN meter m ON m.meter_id = r.meter_id
           JOIN meter_element me ON me.meter_element_id = r.meter_element_id
           WHERE r.created_at >= NOW() - INTERVAL '30 days'
           GROUP BY m.meter_id, m.name, me.meter_element_id, me.element, me.name
           ORDER BY m.name, element`
        )).rows
      : [];

  const virtualResults = await Promise.all(virtualMeterIds.map(vmId =>
    execQuery(
      env,
      `SELECT
         m.name AS meter_name,
         COUNT(*) AS reading_count,
         ROUND(SUM(CASE WHEN mv.operation = '-' THEN -r.kwh ELSE r.kwh END)::numeric, 2) AS total_kwh,
         ROUND(AVG(r.kw)::numeric, 2)                                        AS avg_kw,
         ROUND(MAX(r.kw)::numeric, 2)                                        AS peak_kw,
         ROUND(MIN(r.kw)::numeric, 2)                                        AS min_kw,
         ROUND(AVG(r.power_factor)::numeric, 4)                              AS avg_pf,
         MAX(r.created_at)                                                    AS last_reading_at
       FROM meter_reading r
       JOIN meter_virtual mv
         ON mv.selected_meter_id = r.meter_id
         AND mv.select_meter_element_id = r.meter_element_id
       JOIN meter m ON m.meter_id = mv.meter_id
       WHERE mv.meter_id = $1
         AND r.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY m.meter_id, m.name`,
      [vmId]
    ).then(res => res.rows)
  ));

  const data = filterColumns([...physicalRows, ...virtualResults.flat()], getRegisterFieldNames(report));
  return { type: 'usage_summary', generatedAt: new Date().toISOString(), period: 'Last 30 days', meterCount: data.length, data };
}

async function generateDailySummaryReport(env: Env, report: Report): Promise<ReportData> {
  const { physicalPairs, virtualMeterIds } = await splitMeterSelections(env, report);
  const pairFilter = physicalPairs.length > 0 ? buildPairFilter(physicalPairs, 1) : null;

  const physicalRows = pairFilter
    ? (await execQuery(
        env,
        `SELECT
           DATE(r.created_at)                                                    AS date,
           CONCAT(COALESCE(TRIM(m.name)), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, '?')) AS meter_name,
           COUNT(*)                                                              AS reading_count,
           ROUND(SUM(r.kwh)::numeric, 2)                                        AS total_kwh,
           ROUND(AVG(r.kw)::numeric, 2)                                         AS avg_kw,
           ROUND(MAX(r.kw)::numeric, 2)                                         AS peak_kw
         FROM meter_reading r
         JOIN meter m ON m.meter_id = r.meter_id
         JOIN meter_element me ON me.meter_element_id = r.meter_element_id
         WHERE r.created_at >= NOW() - INTERVAL '30 days' AND ${pairFilter.sql}
         GROUP BY DATE(r.created_at), m.meter_id, m.name, me.meter_element_id, me.element, me.name
         ORDER BY date DESC, m.name, element`,
        pairFilter.params
      )).rows
    : physicalPairs.length === 0 && virtualMeterIds.length === 0
      ? (await execQuery(
          env,
          `SELECT
             DATE(r.created_at)                                                    AS date,
             CONCAT(COALESCE(TRIM(m.name)), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, '?')) AS meter_name,
             COUNT(*)                                                              AS reading_count,
             ROUND(SUM(r.kwh)::numeric, 2)                                        AS total_kwh,
             ROUND(AVG(r.kw)::numeric, 2)                                         AS avg_kw,
             ROUND(MAX(r.kw)::numeric, 2)                                         AS peak_kw
           FROM meter_reading r
           JOIN meter m ON m.meter_id = r.meter_id
           JOIN meter_element me ON me.meter_element_id = r.meter_element_id
           WHERE r.created_at >= NOW() - INTERVAL '30 days'
           GROUP BY DATE(r.created_at), m.meter_id, m.name, me.meter_element_id, me.element, me.name
           ORDER BY date DESC, m.name, element`
        )).rows
      : [];

  const virtualResults = await Promise.all(virtualMeterIds.map(vmId =>
    execQuery(
      env,
      `SELECT
         DATE(r.created_at) AS date,
         m.name AS meter_name,
         COUNT(*) AS reading_count,
         ROUND(SUM(CASE WHEN mv.operation = '-' THEN -r.kwh ELSE r.kwh END)::numeric, 2) AS total_kwh,
         ROUND(AVG(r.kw)::numeric, 2)                                        AS avg_kw,
         ROUND(MAX(r.kw)::numeric, 2)                                        AS peak_kw
       FROM meter_reading r
       JOIN meter_virtual mv
         ON mv.selected_meter_id = r.meter_id
         AND mv.select_meter_element_id = r.meter_element_id
       JOIN meter m ON m.meter_id = mv.meter_id
       WHERE mv.meter_id = $1
         AND r.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(r.created_at), m.meter_id, m.name
       ORDER BY date DESC, m.name`,
      [vmId]
    ).then(res => res.rows)
  ));

  const data = filterColumns([...physicalRows, ...virtualResults.flat()], getRegisterFieldNames(report));
  data.sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));

  return {
    type: 'daily_summary',
    generatedAt: new Date().toISOString(),
    period: 'Last 30 days',
    dayCount: new Set(data.map((r: any) => r.date)).size,
    data,
  };
}

export async function generateDemandReport(env: Env, report: Report): Promise<ReportData> {
  const config = { time_frame: report.time_frame || 'monthly' };
  const { startDate, endDate } = getReportDateRange(config);
  const { physicalPairs, virtualMeterIds } = await splitMeterSelections(env, report);
  const pairFilter = physicalPairs.length > 0 ? buildPairFilter(physicalPairs, 3) : null;

  const physicalRows = pairFilter
    ? (await execQuery(
        env,
        `SELECT
           CONCAT(COALESCE(TRIM(m.name)), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, '?')) AS meter_name,
           ROUND(MAX(r.kw)::numeric, 2)                                            AS peak_demand_kw,
           TO_CHAR(MAX(r.created_at), 'YYYY-MM-DD HH24:MI:SS')                    AS peak_reading_at,
           COUNT(*)::int                                                            AS reading_count
         FROM meter_reading r
         JOIN meter m ON m.meter_id = r.meter_id
         JOIN meter_element me ON me.meter_element_id = r.meter_element_id
         WHERE r.created_at >= $1 AND r.created_at <= $2 AND ${pairFilter.sql}
         GROUP BY m.meter_id, m.name, me.meter_element_id, me.element, me.name
         ORDER BY peak_demand_kw DESC NULLS LAST`,
        [startDate.toISOString(), endDate.toISOString(), ...pairFilter.params]
      )).rows
    : [];

  // Virtual demand: instantaneous sum per timestamp → peak of those sums
  const virtualResults = await Promise.all(virtualMeterIds.map(vmId =>
    execQuery(
      env,
      `WITH virtual_ts AS (
         SELECT r.created_at,
                SUM(CASE WHEN mv.operation = '-' THEN -r.kw ELSE r.kw END) AS instant_kw
         FROM meter_reading r
         JOIN meter_virtual mv
           ON mv.selected_meter_id = r.meter_id
           AND mv.select_meter_element_id = r.meter_element_id
         WHERE mv.meter_id = $1
           AND r.created_at >= $2::timestamptz
           AND r.created_at <= $3::timestamptz
         GROUP BY r.created_at
       )
       SELECT
         (SELECT name FROM meter WHERE meter_id = $1) AS meter_name,
         ROUND(MAX(instant_kw)::numeric, 2) AS peak_demand_kw,
         TO_CHAR(
           (SELECT created_at FROM virtual_ts ORDER BY instant_kw DESC LIMIT 1),
           'YYYY-MM-DD HH24:MI:SS'
         ) AS peak_reading_at,
         COUNT(*)::int AS reading_count
       FROM virtual_ts`,
      [vmId, startDate.toISOString(), endDate.toISOString()]
    ).then(res => res.rows)
  ));

  const timeFrame = report.time_frame || 'monthly';
  const periodLabel = timeFrame.charAt(0).toUpperCase() + timeFrame.slice(1);
  const allRows = [...physicalRows, ...virtualResults.flat()];
  allRows.sort((a: any, b: any) => (Number(b.peak_demand_kw) || 0) - (Number(a.peak_demand_kw) || 0));

  return {
    type: 'demand',
    generatedAt: new Date().toISOString(),
    period: periodLabel,
    meterCount: allRows.length,
    data: allRows,
  };
}

type GroupingType = 'hourly' | 'daily' | 'weekly' | 'monthly';

function groupKeyExpr(g: GroupingType): string {
  switch (g) {
    case 'hourly':  return `TO_CHAR(r.created_at, 'YYYY-MM-DD HH24:00')`;
    case 'daily':   return `TO_CHAR(r.created_at, 'YYYY-MM-DD')`;
    case 'weekly':  return `TO_CHAR(DATE_TRUNC('week', r.created_at), 'YYYY-MM-DD')`;
    case 'monthly': return `TO_CHAR(r.created_at, 'YYYY-MM')`;
  }
}

function formatPeriodKey(key: string, g: GroupingType): string {
  if (g !== 'monthly') return key;
  const [year, month] = key.split('-');
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

async function generateGroupedReport(env: Env, report: Report): Promise<ReportData> {
  const { startDate, endDate } = getReportDateRange(report);
  const rawG = (report.grouping_type || 'monthly').toLowerCase() as GroupingType;
  const grouping: GroupingType = ['hourly', 'daily', 'weekly', 'monthly'].includes(rawG) ? rawG : 'monthly';
  const keyExpr = groupKeyExpr(grouping);

  const { physicalPairs, virtualMeterIds } = await splitMeterSelections(env, report);
  const pairFilter = physicalPairs.length > 0 ? buildPairFilter(physicalPairs, 3) : null;

  const physicalSql = `
    SELECT
      ${keyExpr} AS sort_key,
      CONCAT(COALESCE(TRIM(m.name)), ' (', COALESCE(TRIM(me.element), '?'), ') ', COALESCE(me.name, '?')) AS meter_name,
      ROUND(SUM(r.kwh)::numeric, 2) AS total_kwh,
      ROUND(AVG(r.kw)::numeric, 2) AS avg_kw,
      ROUND(MAX(r.kw)::numeric, 2) AS peak_kw,
      COUNT(*)::int AS reading_count
    FROM meter_reading r
    JOIN meter m ON m.meter_id = r.meter_id
    JOIN meter_element me ON me.meter_element_id = r.meter_element_id
    WHERE r.created_at >= $1 AND r.created_at <= $2${pairFilter ? ` AND ${pairFilter.sql}` : ''}
    GROUP BY ${keyExpr}, m.meter_id, m.name, me.meter_element_id, me.element, me.name
    ORDER BY sort_key, meter_name`;

  const physicalRows = pairFilter || (physicalPairs.length === 0 && virtualMeterIds.length === 0)
    ? (await execQuery(env, physicalSql, [startDate.toISOString(), endDate.toISOString(), ...(pairFilter?.params ?? [])])).rows
    : [];

  const virtualResults = await Promise.all(virtualMeterIds.map(vmId =>
    execQuery(env, `
      SELECT
        ${keyExpr} AS sort_key,
        m.name AS meter_name,
        ROUND(SUM(CASE WHEN mv.operation = '-' THEN -r.kwh ELSE r.kwh END)::numeric, 2) AS total_kwh,
        ROUND(AVG(r.kw)::numeric, 2) AS avg_kw,
        ROUND(MAX(r.kw)::numeric, 2) AS peak_kw,
        COUNT(*)::int AS reading_count
      FROM meter_reading r
      JOIN meter_virtual mv ON mv.selected_meter_id = r.meter_id AND mv.select_meter_element_id = r.meter_element_id
      JOIN meter m ON m.meter_id = mv.meter_id
      WHERE mv.meter_id = $1 AND r.created_at >= $2 AND r.created_at <= $3
      GROUP BY ${keyExpr}, m.meter_id, m.name
      ORDER BY sort_key, meter_name`,
      [vmId, startDate.toISOString(), endDate.toISOString()]
    ).then(res => res.rows)
  ));

  const combined = [...physicalRows, ...virtualResults.flat()];
  combined.sort((a: any, b: any) => String(a.sort_key).localeCompare(String(b.sort_key)) || String(a.meter_name).localeCompare(String(b.meter_name)));

  const data = combined.map(({ sort_key, ...rest }: any) => ({
    period: formatPeriodKey(String(sort_key), grouping),
    ...rest,
  }));

  const selectedFields = getRegisterFieldNames(report);
  let finalData = data;
  if (selectedFields) {
    const keep = new Set<string>(['period', 'meter_name', 'reading_count']);
    if (selectedFields.includes('kwh'))          keep.add('total_kwh');
    if (selectedFields.includes('kw'))           { keep.add('avg_kw'); keep.add('peak_kw'); }
    if (selectedFields.includes('power_factor')) keep.add('avg_pf');
    finalData = data.map((row: any) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k)))
    );
  }

  const timeFrameLabel = (report.time_frame || 'yearly').charAt(0).toUpperCase() + (report.time_frame || 'yearly').slice(1);

  return {
    type: report.type,
    generatedAt: new Date().toISOString(),
    period: timeFrameLabel,
    recordCount: finalData.length,
    meterCount: new Set(data.map((r: any) => r.meter_name)).size,
    data: finalData,
  };
}

async function generateReportData(env: Env, report: Report): Promise<ReportData> {
  if (report.grouping_type) return generateGroupedReport(env, report);
  switch (report.type) {
    case 'meter_readings': return generateMeterReadingsReport(env, report);
    case 'usage_summary': return generateUsageSummaryReport(env, report);
    case 'daily_summary': return generateDailySummaryReport(env, report);
    case 'demand': return generateDemandReport(env, report);
    default:
      console.warn(`[reportRunner] Unknown report type: ${report.type}`);
      return { type: report.type, generatedAt: new Date().toISOString(), data: [] };
  }
}

// --- HTML preview (respects display_type / export_format from settings) -------

function buildPreviewHtml(report: Report, reportData: ReportData, chartData: ChartSeriesData): string {
  const displayType: string = report.visualization_type || 'bar';
  const exportFormat: string = report.attach_as || 'html';
  const isPdf = exportFormat === 'pdf';

  const rows = Array.isArray(reportData.data) ? reportData.data : [];
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const hasChartData = chartData.series.length > 0 && chartData.labels.length > 0;
  const useChart = ['bar', 'line', 'pie'].includes(displayType) && hasChartData;

  const meta = [
    reportData.period ? `<span>Period: <strong>${reportData.period}</strong></span>` : '',
    reportData.recordCount != null ? `<span>Records: <strong>${reportData.recordCount}</strong></span>` : '',
    reportData.meterCount != null ? `<span>Meters: <strong>${reportData.meterCount}</strong></span>` : '',
    reportData.dayCount != null ? `<span>Days: <strong>${reportData.dayCount}</strong></span>` : '',
  ].filter(Boolean).join('<span style="margin:0 10px;color:#d1d5db">|</span>');

  // -- Table (grid) � always shown below the chart --------------------------
  const tableHtml = rows.length === 0
    ? '<p style="color:#6b7280;font-style:italic;text-align:center;padding:40px 0">No data available for this report.</p>'
    : `<div style="overflow-x:auto;margin-top:24px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#1a56db;color:#fff">
              ${headers.map(h => `<th style="padding:8px 12px;text-align:left;white-space:nowrap;text-transform:capitalize">${h.replace(/_/g, ' ')}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row, i) => `
              <tr style="${i % 2 ? 'background:#f9fafb' : ''}">
                ${headers.map(h => `<td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top">${formatValue(row[h])}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

  // -- Chart � uses the same aggregated time-series data as the dashboard ---
  let dataScript = '';
  let chartHtml = '';
  let initScript = '';

  if (useChart) {
    const palette = ['#0ea5e9', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#a855f7'];
    const isPie = displayType === 'pie';
    const isLine = displayType === 'line';

    // For pie: sum each series into one value
    const datasets = isPie
      ? [{
          data: chartData.series.map(s => parseFloat(s.data.reduce((a, b) => a + b, 0).toFixed(4))),
          backgroundColor: chartData.series.map((_, i) => palette[i % palette.length]),
          borderWidth: 1,
        }]
      : chartData.series.map((s, i) => ({
          label: s.name,
          data: s.data.map(v => parseFloat(v.toFixed(4))),
          backgroundColor: isLine ? palette[i % palette.length] + '22' : palette[i % palette.length],
          borderColor: palette[i % palette.length],
          borderWidth: isLine ? 2 : 1,
          borderRadius: !isLine ? 4 : 0,
          fill: isLine,
          tension: isLine ? 0.3 : 0,
          pointRadius: isLine ? 0 : 3,
        }));

    const pieLabels = isPie ? chartData.series.map(s => s.name) : chartData.labels;

    dataScript = `<script>window.__CD__=${JSON.stringify({
      type: displayType,
      labels: pieLabels,
      datasets,
      unit: chartData.unit,
      isPdf,
    })};</script>`;

    chartHtml = `<div style="position:relative;max-width:900px;margin:0 auto 8px"><canvas id="rc"></canvas></div>`;

    initScript = `<script>
(function(){
  var d=window.__CD__;
  var isPie=d.type==='pie';
  new Chart(document.getElementById('rc'),{
    type: d.type,
    data:{ labels: d.labels, datasets: d.datasets },
    options:{
      responsive:true,
      maintainAspectRatio:true,
      plugins:{
        legend:{ display:true, position:'bottom', labels:{padding:16,usePointStyle:true,font:{size:12}} },
        tooltip:{ callbacks:{ label:function(ctx){ return ' '+ctx.dataset.label+': '+Number(ctx.raw).toFixed(4)+' '+d.unit; } } }
      },
      scales: isPie ? {} : {
        x:{ grid:{color:'rgba(0,0,0,0.05)',borderDash:[3,3]}, ticks:{maxRotation:45,minRotation:0,font:{size:11}} },
        y:{ beginAtZero:true, grid:{color:'rgba(0,0,0,0.05)',borderDash:[3,3]}, ticks:{font:{size:11}}, title:{display:true,text:d.unit,font:{size:11}} }
      }
    }
  });
  if(d.isPdf){window.addEventListener('load',function(){setTimeout(function(){window.print();},700);});}
})();
</script>`;
  }

  const pdfAutoprint = !useChart && isPdf
    ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${report.name}</title>
  ${useChart ? '<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>' : ''}
  ${dataScript}
  <style>
    *{box-sizing:border-box}
    body{font-family:Arial,sans-serif;font-size:13px;color:#111;background:#fff;padding:24px;margin:0}
    @media print{.no-print{display:none}body{padding:12px}}
  </style>
</head>
<body>
  <div style="border-bottom:2px solid #1a56db;padding-bottom:12px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-end">
    <div>
      <h1 style="font-size:22px;color:#1a56db;margin:0">${report.name}</h1>
      <p style="color:#555;margin:4px 0 0;font-size:11px">Type: ${report.type}&nbsp;|&nbsp;Generated: ${new Date().toLocaleString()}</p>
    </div>
    <button class="no-print" onclick="window.print()" style="padding:6px 14px;border:1px solid #1a56db;color:#1a56db;background:#fff;border-radius:4px;cursor:pointer;font-size:12px">Print / Save PDF</button>
  </div>
  ${meta ? `<div style="margin-bottom:16px;color:#555;font-size:12px;display:flex;gap:4px;flex-wrap:wrap">${meta}</div>` : ''}
  ${useChart ? chartHtml : tableHtml}
  ${initScript}
  ${pdfAutoprint}
</body>
</html>`;
}

// --- HTML email body ----------------------------------------------------------

function buildEmailChartUrl(report: Report, chartData: ChartSeriesData): string {
  const displayType = report.visualization_type || 'bar';
  const isPie = displayType === 'pie';
  const isLine = displayType === 'line';
  const palette = ['#0ea5e9', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#a855f7'];

  const datasets = isPie
    ? [{
        data: chartData.series.map(s => parseFloat(s.data.reduce((a, b) => a + b, 0).toFixed(4))),
        backgroundColor: chartData.series.map((_, i) => palette[i % palette.length]),
      }]
    : chartData.series.map((s, i) => ({
        label: s.name,
        data: s.data.map(v => parseFloat(v.toFixed(4))),
        backgroundColor: isLine ? palette[i % palette.length] + '22' : palette[i % palette.length],
        borderColor: palette[i % palette.length],
        borderWidth: isLine ? 2 : 1,
        fill: isLine,
        tension: isLine ? 0.3 : 0,
      }));

  const labels = isPie ? chartData.series.map(s => s.name) : chartData.labels;

  const config = {
    type: displayType,
    data: { labels, datasets },
    options: {
      plugins: { legend: { position: 'bottom' } },
      scales: isPie ? {} : {
        y: { beginAtZero: true, title: { display: !!chartData.unit, text: chartData.unit } },
      },
    },
  };

  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&width=600&height=300&backgroundColor=white`;
}

function buildEmailHtml(report: Report, reportData: ReportData, chartData: ChartSeriesData): string {
  const displayType: string = report.visualization_type || 'bar';
  const hasChartData = chartData.series.length > 0 && chartData.labels.length > 0;
  const useChart = ['bar', 'line', 'pie'].includes(displayType) && hasChartData;

  const rows = Array.isArray(reportData.data) ? reportData.data : [];
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const displayRows = rows.slice(0, 100);

  const contentHtml = useChart
    ? `<img src="${buildEmailChartUrl(report, chartData)}" alt="${report.name} chart" style="max-width:100%;height:auto;display:block;margin:0 auto" />`
    : rows.length === 0
      ? '<p style="color:#6b7280;font-style:italic">No data available for this report.</p>'
      : `<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:12px">
          <thead>
            <tr style="background:#1a56db;color:#fff">
              ${headers.map(h => `<th style="padding:6px 8px;text-align:left;text-transform:capitalize">${h.replace(/_/g, ' ')}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${displayRows.map((row, i) => `
              <tr style="${i % 2 === 1 ? 'background:#f9fafb' : ''}">
                ${headers.map(h => `<td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top">${formatValue(row[h])}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
         </table>
         ${rows.length > 100 ? `<p style="color:#6b7280;font-size:11px;margin-top:8px">Showing first 100 of ${rows.length} records.</p>` : ''}`;

  const meta = [
    reportData.period ? `<p><strong>Period:</strong> ${reportData.period}</p>` : '',
    reportData.recordCount != null ? `<p><strong>Records:</strong> ${reportData.recordCount}</p>` : '',
    reportData.meterCount != null ? `<p><strong>Meters:</strong> ${reportData.meterCount}</p>` : '',
    reportData.dayCount != null ? `<p><strong>Days:</strong> ${reportData.dayCount}</p>` : '',
  ].filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${report.name}</title></head>
<body style="font-family:Arial,sans-serif;font-size:13px;color:#111;background:#fff;padding:24px;margin:0">
  <div style="border-bottom:2px solid #1a56db;padding-bottom:12px;margin-bottom:16px">
    <h1 style="font-size:20px;color:#1a56db;margin:0">${report.name}</h1>
    <p style="color:#555;margin-top:4px;font-size:11px">Type: ${report.type} &nbsp;|&nbsp; Generated: ${new Date().toLocaleString()}</p>
  </div>
  <div style="margin-bottom:16px">${meta}</div>
  ${contentHtml}
  <p style="color:#9ca3af;font-size:11px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:12px">
    This is an automated report from MeterItPro. Please do not reply to this email.
  </p>
</body>
</html>`;
}

// --- Email via Resend ---------------------------------------------------------

interface EmailAttachment {
  filename: string;
  content: string; // base64-encoded
}

async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  fromOverride?: string | null,
  attachments?: EmailAttachment[]
): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured — run: npx wrangler secret put RESEND_API_KEY');

  const from = fromOverride || (env as any).RESEND_FROM || 'MeterItPro <noreply@meteritpro.com>';

  const payload: Record<string, unknown> = { from, to, subject, html };
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error (${res.status}): ${err}`);
  }
}

function buildCsvContent(reportData: ReportData): string {
  const rows = Array.isArray(reportData.data) ? reportData.data : [];
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\r\n');
}

function buildCsvEmailHtml(report: Report, reportData: ReportData): string {
  const meta = [
    reportData.period ? `<p><strong>Period:</strong> ${reportData.period}</p>` : '',
    reportData.recordCount != null ? `<p><strong>Records:</strong> ${reportData.recordCount}</p>` : '',
    reportData.meterCount != null ? `<p><strong>Meters:</strong> ${reportData.meterCount}</p>` : '',
    reportData.dayCount != null ? `<p><strong>Days:</strong> ${reportData.dayCount}</p>` : '',
  ].filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${report.name}</title></head>
<body style="font-family:Arial,sans-serif;font-size:13px;color:#111;background:#fff;padding:24px;margin:0">
  <div style="border-bottom:2px solid #1a56db;padding-bottom:12px;margin-bottom:16px">
    <h1 style="font-size:20px;color:#1a56db;margin:0">${report.name}</h1>
    <p style="color:#555;margin-top:4px;font-size:11px">Type: ${report.type} &nbsp;|&nbsp; Generated: ${new Date().toLocaleString()}</p>
  </div>
  <div style="margin-bottom:16px">${meta}</div>
  <p>Please find the report data attached as a CSV file.</p>
  <p style="color:#9ca3af;font-size:11px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:12px">
    This is an automated report from MeterItPro. Please do not reply to this email.
  </p>
</body>
</html>`;
}

// --- History helpers ----------------------------------------------------------

async function createHistoryEntry(
  env: Env,
  reportId: number,
  executedAt: Date,
  status: 'pending' | 'success' | 'failed',
  errorMessage: string | null
): Promise<number> {
  const result = await execQuery(
    env,
    `INSERT INTO report_history (report_id, executed_at, status, error_message, created_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING report_history_id`,
    [reportId, executedAt, status, errorMessage, new Date()]
  );
  if (result.rows.length === 0) throw new Error('Failed to create history entry');
  return result.rows[0].report_history_id;
}

async function updateHistoryEntry(
  env: Env,
  historyId: number,
  status: 'success' | 'failed',
  errorMessage: string | null
): Promise<void> {
  await execQuery(
    env,
    `UPDATE report_history SET status = $1, error_message = $2 WHERE report_history_id = $3`,
    [status, errorMessage, historyId]
  );
}

async function createEmailLogEntry(
  env: Env,
  reportId: number,
  historyId: number,
  recipient: string,
  sentAt: Date,
  status: 'delivered' | 'failed',
  errorDetails: string | null
): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO report_email_logs (report_id, report_history_id, recipient, sent_at, status, error_details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [reportId, historyId, recipient, sentAt, status, errorDetails, new Date()]
  );
}

// --- Public API ---------------------------------------------------------------

/**
 * Generate and return the HTML preview for a report without sending emails.
 */
export async function previewReport(env: Env, reportId: number, tenantId?: number): Promise<string> {
  const reportResult = await execQuery(
    env,
    `SELECT report_id, name, type, tenant_id, recipients, meter_selections, time_frame, visualization_type, grouping_type, attach_as
     FROM report WHERE report_id = $1`,
    [reportId]
  );

  if (reportResult.rows.length === 0) {
    throw new Error(`Report ${reportId} not found`);
  }

  const report = reportResult.rows[0];
  const [reportData, chartData] = await Promise.all([
    generateReportData(env, report),
    fetchChartSeriesData(env, report, tenantId),
  ]);
  return buildPreviewHtml(report, reportData, chartData);
}

/**
 * Execute a single report: generate data, send emails, record history.
 * Throws on fatal errors; partial email failures are logged but not thrown.
 */
export async function runReport(env: Env, reportId: number): Promise<void> {
  const reportResult = await execQuery(
    env,
    `SELECT report_id, name, type, tenant_id, recipients, meter_selections, time_frame, visualization_type, grouping_type, attach_as
     FROM report WHERE report_id = $1 AND active = true`,
    [reportId]
  );

  if (reportResult.rows.length === 0) {
    throw new Error(`Report ${reportId} not found or inactive`);
  }

  const report = reportResult.rows[0];
  const executedAt = new Date();
  let historyId: number | null = null;

  try {
    const [reportData, chartData] = await Promise.all([
      generateReportData(env, report),
      fetchChartSeriesData(env, report, report.tenant_id),
    ]);
    historyId = await createHistoryEntry(env, report.report_id, executedAt, 'pending', null);

    const isCsv = (report.attach_as || 'html') === 'csv';
    let html: string;
    let attachments: EmailAttachment[] | undefined;

    if (isCsv) {
      html = buildCsvEmailHtml(report, reportData);
      const csvContent = buildCsvContent(reportData);
      const base64Csv = btoa(unescape(encodeURIComponent(csvContent)));
      const safeName = report.name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
      attachments = [{ filename: `${safeName}.csv`, content: base64Csv }];
    } else {
      html = buildEmailHtml(report, reportData, chartData);
    }

    const subject = `Report: ${report.name}`;
    const failures: string[] = [];

    const toList = report.recipients?.to ?? [];
    const fromOverride = report.recipients?.from;
    for (const recipient of toList) {
      try {
        await sendEmail(env, recipient, subject, html, fromOverride, attachments);
        await createEmailLogEntry(env, report.report_id, historyId, recipient, executedAt, 'delivered', null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${recipient}: ${msg}`);
        await createEmailLogEntry(env, report.report_id, historyId, recipient, executedAt, 'failed', msg).catch(() => { });
      }
    }

    if (failures.length > 0) {
      throw new Error(`Email delivery failed for ${failures.length} recipient(s): ${failures.join('; ')}`);
    }

    await updateHistoryEntry(env, historyId, 'success', null);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (historyId !== null) {
      await updateHistoryEntry(env, historyId, 'failed', msg).catch(() => { });
    } else {
      await createHistoryEntry(env, reportId, executedAt, 'failed', msg).catch(() => { });
    }
    throw error;
  }
}

/**
 * Run all active reports whose cron schedule matches `now` � used by the cron trigger.
 * Pass the scheduled event time so reports fire only at their configured time.
 */
export async function runAllActiveReports(env: Env, now: Date = new Date()): Promise<void> {
  const result = await execQuery(
    env,
    `SELECT report_id, cron FROM report WHERE active = true`
  );

  for (const row of result.rows) {
    if (!matchesCronSchedule(row.cron, now)) {
      continue;
    }

    try {
      await runReport(env, row.report_id);
    } catch (err) {
      console.error(`[cron] Report ${row.report_id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
