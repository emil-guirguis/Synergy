import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AnomalyInsightsPanel } from './AnomalyInsightsPanel';
import { dashboardService } from '../../services/dashboardService';

vi.mock('../../services/dashboardService', () => ({
  dashboardService: {
    getAnomalies: vi.fn(),
  },
}));

const mockGetAnomalies = vi.mocked(dashboardService.getAnomalies);

describe('AnomalyInsightsPanel', () => {
  it('renders nothing while there are no anomalies', async () => {
    mockGetAnomalies.mockResolvedValueOnce([]);
    render(<AnomalyInsightsPanel />);
    await waitFor(() => expect(mockGetAnomalies).toHaveBeenCalled());
    expect(screen.queryByTestId('anomaly-insights-panel')).not.toBeInTheDocument();
  });

  it('lists recent anomalies once loaded', async () => {
    mockGetAnomalies.mockResolvedValueOnce([
      {
        meter_reading_anomaly_id: 1,
        meter_id: 1,
        meter_element_id: 1,
        metric: 'kw',
        reading_at: '2026-09-28T12:00:00Z',
        // pg returns NUMERIC columns as strings — mocking that shape is what caught
        // the original .toFixed() crash on a string value.
        actual_value: '42.5',
        expected_value: '10.2',
        deviation: '3.1',
        z_score: '10.4',
        detected_at: '2026-09-28T12:05:00Z',
        meter_name: 'Meter A',
        element_code: 'A',
        element_name: 'Phase A',
      },
    ]);

    render(<AnomalyInsightsPanel />);

    expect(await screen.findByTestId('anomaly-insights-panel')).toBeInTheDocument();
    expect(screen.getByText(/Meter A/)).toBeInTheDocument();
    expect(screen.getByText(/42.5 kW vs ~10.2 kW expected/)).toBeInTheDocument();
  });
});
