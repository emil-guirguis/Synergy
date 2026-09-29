/**
 * Quality engine: incremental gap + spike detection for meter readings.
 *
 * Maintains meter_reading_gap and meter_element_watermark (migration 045),
 * and meter_reading_anomaly (migration 054). Runs from the Worker cron
 * before notification rules, so rules can query gaps/anomalies instead of
 * rescanning meter_reading with window functions.
 *
 * All steps are set-based SQL — a handful of statements per run regardless
 * of meter count. Only readings newer than each element's watermark are
 * scanned; old data is never revisited.
 *
 * Gap semantics:
 *   - gap_end NULL          = tail gap, element currently silent
 *   - status 'open'         = data missing in [gap_start, gap_end)
 *   - status 'closed'       = backfill arrived, gap no longer real
 *   - status 'filled'       = estimation wrote synthetic readings (future)
 */

import { Env, execQuery } from './db';

// First run for an element scans this far back instead of all history.
const BOOTSTRAP_WINDOW_HOURS = 48;

// Delta must exceed interval by this much before it counts as a gap
// (matches the old runner's 20-minute threshold for 15-minute data).
const GAP_TOLERANCE_MINUTES = 5;

// Spike baseline: trailing window each new kW reading is compared against.
const SPIKE_BASELINE_DAYS = 7;
// Baseline needs at least this many prior readings before it's trusted
// (a handful of points would make stddev noise-dominated).
const SPIKE_MIN_SAMPLES = 20;
// Flag when |actual - avg| exceeds this many standard deviations...
const SPIKE_Z_THRESHOLD = 3;
// ...AND exceeds this absolute floor (kW), so a near-zero baseline (an idle
// element where 0.1kW is a 10x jump) doesn't flood the table with noise.
const SPIKE_MIN_ABS_DELTA_KW = 1;

/** Step 1: ensure a watermark row exists for every active meter element. */
async function seedWatermarks(env: Env): Promise<void> {
  await execQuery(env, `
    INSERT INTO meter_element_watermark (tenant_id, meter_id, meter_element_id)
    SELECT m.tenant_id, m.meter_id, me.meter_element_id
    FROM meter m
    JOIN meter_element me ON me.meter_id = m.meter_id
    WHERE m.active = true
    ON CONFLICT (meter_element_id) DO NOTHING`);
}

/**
 * Step 2: detect interior gaps among newly arrived readings.
 * LAG over readings past each element's watermark; the previous watermark's
 * last_reading_at serves as the boundary row so cross-run gaps are caught.
 */
async function insertInteriorGaps(env: Env): Promise<number> {
  const result = await execQuery(env, `
    WITH scan AS (
      SELECT w.tenant_id, w.meter_id, w.meter_element_id,
             w.expected_interval_minutes,
             r.created_at AS ts,
             COALESCE(
               LAG(r.created_at) OVER (PARTITION BY w.meter_element_id ORDER BY r.created_at),
               w.last_reading_at
             ) AS prev_ts
      FROM meter_element_watermark w
      JOIN meter_reading r
        ON r.tenant_id = w.tenant_id
       AND r.meter_id = w.meter_id
       AND r.meter_element_id = w.meter_element_id
       AND r.created_at > COALESCE(w.last_checked_at, NOW() - INTERVAL '${BOOTSTRAP_WINDOW_HOURS} hours')
      WHERE w.active = true
    )
    INSERT INTO meter_reading_gap
      (tenant_id, meter_id, meter_element_id, gap_start, gap_end,
       expected_interval_minutes, missing_count)
    SELECT tenant_id, meter_id, meter_element_id,
           prev_ts + (expected_interval_minutes || ' minutes')::interval,
           ts,
           expected_interval_minutes,
           GREATEST(
             FLOOR(EXTRACT(EPOCH FROM (ts - prev_ts)) / (expected_interval_minutes * 60))::int - 1,
             1
           )
    FROM scan
    WHERE prev_ts IS NOT NULL
      AND ts > prev_ts + ((expected_interval_minutes + ${GAP_TOLERANCE_MINUTES}) || ' minutes')::interval
    RETURNING meter_reading_gap_id`);
  return result.rows.length;
}

/**
 * Step 3: resolve tail gaps where data has resumed — set gap_end to the
 * first reading at/after gap_start. The gap stays 'open' (that range is
 * still missing data) until backfill closes it in step 4.
 */
async function resolveTailGaps(env: Env): Promise<number> {
  const result = await execQuery(env, `
    UPDATE meter_reading_gap g
    SET gap_end = f.first_ts,
        missing_count = GREATEST(
          FLOOR(EXTRACT(EPOCH FROM (f.first_ts - g.gap_start)) / (g.expected_interval_minutes * 60))::int,
          0
        ),
        updated_at = NOW()
    FROM (
      SELECT g2.meter_reading_gap_id, MIN(r.created_at) AS first_ts
      FROM meter_reading_gap g2
      JOIN meter_reading r
        ON r.tenant_id = g2.tenant_id
       AND r.meter_id = g2.meter_id
       AND r.meter_element_id = g2.meter_element_id
       AND r.created_at >= g2.gap_start
      WHERE g2.status = 'open' AND g2.gap_end IS NULL
      GROUP BY g2.meter_reading_gap_id
    ) f
    WHERE g.meter_reading_gap_id = f.meter_reading_gap_id
    RETURNING g.meter_reading_gap_id`);
  return result.rows.length;
}

/**
 * Step 4: close gaps that backfill has since filled (e.g. BACnet reconnect
 * batch with old timestamps — invisible to the watermark scan, so checked
 * directly against open gaps; there are few of those at any time).
 */
async function closeBackfilledGaps(env: Env): Promise<number> {
  const result = await execQuery(env, `
    UPDATE meter_reading_gap g
    SET status = 'closed', closed_at = NOW(), updated_at = NOW()
    WHERE g.status = 'open'
      AND g.gap_end IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM meter_reading r
        WHERE r.tenant_id = g.tenant_id
          AND r.meter_id = g.meter_id
          AND r.meter_element_id = g.meter_element_id
          AND r.created_at > g.gap_start
          AND r.created_at < g.gap_end
      )
    RETURNING g.meter_reading_gap_id`);
  return result.rows.length;
}

/**
 * Step 5: flag newly arrived readings whose kW deviates sharply from the
 * element's own trailing baseline (LATERAL join keeps the baseline scoped to
 * each row's own history, bounded by idx_meter_reading_lookup's
 * (tenant_id, meter_id, meter_element_id, created_at) prefix — cheap even
 * though it runs once per new reading rather than once per element).
 * Shares the gap-detection watermark as its "already scanned" cursor since
 * both run over the same newly-arrived rows in the same cycle — MUST run
 * before updateWatermarks advances that cursor past them.
 */
async function detectSpikes(env: Env): Promise<number> {
  const result = await execQuery(env, `
    WITH new_readings AS (
      SELECT r.meter_reading_id, r.tenant_id, r.meter_id, r.meter_element_id,
             r.created_at, r.kw
      FROM meter_element_watermark w
      JOIN meter_reading r
        ON r.tenant_id = w.tenant_id
       AND r.meter_id = w.meter_id
       AND r.meter_element_id = w.meter_element_id
       AND r.created_at > COALESCE(w.last_checked_at, NOW() - INTERVAL '${BOOTSTRAP_WINDOW_HOURS} hours')
      WHERE w.active = true AND r.kw IS NOT NULL
    ),
    scored AS (
      SELECT nr.*, b.avg_kw, b.stddev_kw, b.sample_count
      FROM new_readings nr
      CROSS JOIN LATERAL (
        SELECT AVG(h.kw) AS avg_kw, STDDEV_SAMP(h.kw) AS stddev_kw, COUNT(*) AS sample_count
        FROM meter_reading h
        WHERE h.tenant_id = nr.tenant_id
          AND h.meter_id = nr.meter_id
          AND h.meter_element_id = nr.meter_element_id
          AND h.created_at >= nr.created_at - INTERVAL '${SPIKE_BASELINE_DAYS} days'
          AND h.created_at < nr.created_at
          AND h.kw IS NOT NULL
      ) b
    )
    INSERT INTO meter_reading_anomaly
      (tenant_id, meter_id, meter_element_id, meter_reading_id, metric,
       reading_at, actual_value, expected_value, deviation, z_score)
    SELECT tenant_id, meter_id, meter_element_id, meter_reading_id, 'kw',
           created_at, kw, avg_kw, stddev_kw,
           CASE WHEN stddev_kw > 0 THEN ABS(kw - avg_kw) / stddev_kw ELSE NULL END
    FROM scored
    WHERE sample_count >= ${SPIKE_MIN_SAMPLES}
      AND stddev_kw > 0
      AND ABS(kw - avg_kw) > GREATEST(${SPIKE_Z_THRESHOLD} * stddev_kw, ${SPIKE_MIN_ABS_DELTA_KW})
    ON CONFLICT (meter_reading_id) DO NOTHING
    RETURNING meter_reading_anomaly_id`);
  return result.rows.length;
}

/** Step 6: advance watermarks past the readings scanned this run. */
async function updateWatermarks(env: Env): Promise<void> {
  await execQuery(env, `
    UPDATE meter_element_watermark w
    SET last_reading_at = GREATEST(COALESCE(w.last_reading_at, '-infinity'::timestamptz), s.max_ts),
        last_checked_at = GREATEST(COALESCE(w.last_checked_at, '-infinity'::timestamptz), s.max_ts),
        updated_at = NOW()
    FROM (
      SELECT w2.meter_element_watermark_id, MAX(r.created_at) AS max_ts
      FROM meter_element_watermark w2
      JOIN meter_reading r
        ON r.tenant_id = w2.tenant_id
       AND r.meter_id = w2.meter_id
       AND r.meter_element_id = w2.meter_element_id
       AND r.created_at > COALESCE(w2.last_checked_at, NOW() - INTERVAL '${BOOTSTRAP_WINDOW_HOURS} hours')
      WHERE w2.active = true
      GROUP BY w2.meter_element_watermark_id
    ) s
    WHERE w.meter_element_watermark_id = s.meter_element_watermark_id`);
}

/**
 * Step 7: open a tail gap for every element that has gone silent
 * (no reading for 2× its expected interval) and has no open tail gap yet.
 * The partial unique index from migration 045 guards against duplicates.
 */
async function openTailGaps(env: Env): Promise<number> {
  const result = await execQuery(env, `
    INSERT INTO meter_reading_gap
      (tenant_id, meter_id, meter_element_id, gap_start, expected_interval_minutes)
    SELECT w.tenant_id, w.meter_id, w.meter_element_id,
           w.last_reading_at + (w.expected_interval_minutes || ' minutes')::interval,
           w.expected_interval_minutes
    FROM meter_element_watermark w
    WHERE w.active = true
      AND w.last_reading_at IS NOT NULL
      AND w.last_reading_at < NOW() - ((w.expected_interval_minutes * 2) || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1 FROM meter_reading_gap g
        WHERE g.meter_element_id = w.meter_element_id
          AND g.status = 'open' AND g.gap_end IS NULL
      )
    ON CONFLICT DO NOTHING
    RETURNING meter_reading_gap_id`);
  return result.rows.length;
}

/** Run one full engine cycle. Order matters — see step comments. */
export async function runQualityEngine(env: Env): Promise<void> {
  await seedWatermarks(env);
  const interior = await insertInteriorGaps(env);
  const resolved = await resolveTailGaps(env);
  const closed = await closeBackfilledGaps(env);
  const spikes = await detectSpikes(env);
  await updateWatermarks(env);
  const tails = await openTailGaps(env);
  console.log(
    `[qualityEngine] gaps: +${interior} interior, ${resolved} tail resolved, ${closed} backfill-closed, +${tails} tail opened; anomalies: +${spikes}`
  );
}
