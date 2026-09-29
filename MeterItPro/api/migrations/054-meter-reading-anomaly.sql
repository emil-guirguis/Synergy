-- Anomaly detection: one row per reading whose kW deviates sharply from its
-- element's own recent baseline. Phase 2 of the data-trust / VEE layer
-- (phase 1 was gap tracking, migration 045).

CREATE TABLE IF NOT EXISTS public.meter_reading_anomaly (
  meter_reading_anomaly_id SERIAL PRIMARY KEY,
  tenant_id                BIGINT NOT NULL REFERENCES public.tenant(tenant_id),
  meter_id                 BIGINT NOT NULL,
  meter_element_id         BIGINT NOT NULL,
  meter_reading_id         UUID NOT NULL UNIQUE,   -- one anomaly row per reading, no re-flagging on rerun
  metric                   VARCHAR(20) NOT NULL DEFAULT 'kw',
  reading_at               TIMESTAMPTZ NOT NULL,
  actual_value             NUMERIC NOT NULL,
  expected_value           NUMERIC NOT NULL,           -- trailing baseline average
  deviation                NUMERIC NOT NULL,           -- trailing baseline stddev
  z_score                  NUMERIC,
  detected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meter_reading_anomaly_tenant_time
  ON public.meter_reading_anomaly (tenant_id, reading_at DESC);
CREATE INDEX IF NOT EXISTS idx_meter_reading_anomaly_element
  ON public.meter_reading_anomaly (meter_element_id, reading_at DESC);

-- RLS: same pattern as 045 — enable, no policies (Worker connects as superuser via Hyperdrive).
ALTER TABLE public.meter_reading_anomaly ENABLE ROW LEVEL SECURITY;
