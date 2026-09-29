import React, { useEffect, useState } from 'react';
import { Box, Paper, Typography, Chip } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { dashboardService, type MeterAnomaly } from '../../services/dashboardService';

/** Surfaces the most recent kW spikes the quality engine flagged (meter_reading_anomaly). */
export const AnomalyInsightsPanel: React.FC = () => {
  const [anomalies, setAnomalies] = useState<MeterAnomaly[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    dashboardService.getAnomalies(5).then((rows) => {
      if (!cancelled) setAnomalies(rows);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading || anomalies.length === 0) return null;

  return (
    <Paper data-testid="anomaly-insights-panel" sx={{ p: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <WarningAmberIcon color="warning" fontSize="small" />
        <Typography variant="subtitle1" fontWeight={600}>Anomaly Insights</Typography>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {anomalies.map((a) => {
          const elementLabel = a.element_name || a.element_code || `Element ${a.meter_element_id}`;
          const readingTime = new Date(a.reading_at).toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          });
          return (
            <Box
              key={a.meter_reading_anomaly_id}
              sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}
            >
              <Typography variant="body2">
                <strong>{a.meter_name}</strong> ({elementLabel}) — {readingTime}
              </Typography>
              <Chip
                size="small"
                color="warning"
                label={`${Number(a.actual_value).toFixed(1)} kW vs ~${Number(a.expected_value).toFixed(1)} kW expected`}
              />
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
};

export default AnomalyInsightsPanel;
