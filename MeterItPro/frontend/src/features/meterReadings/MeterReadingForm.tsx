/**
 * Meter Reading Form Component
 * 
 * Main container component that orchestrates data fetching and sub-component rendering
 * for displaying the most recent meter reading for a specific meter element.
 */

import React, { useState, useEffect } from 'react';
import type {
  MeterReadingFormProps,
  MeterReadingFormState,
  GraphDataPoint,
  Meter,
  MeterReading,
} from './types';
import { MeterInfoPanel } from './MeterInfoPanel';
import { ReadingDataTable } from './ReadingDataTable';
import { useMeterReadingsEnhanced } from './meterReadingsStore';
import { useMeterSelection } from '../../contexts/MeterSelectionContext';
import './MeterReadingForm.css';
import './MeterInfoPanel.css';
import './ReadingDataTable.css';

/**
 * MeterReadingForm Component
 * 
 * Manages form state and data fetching for meter reading display
 * 
 * @param meterElementId - The ID of the meter element to display
 * @param onNavigateToList - Optional callback when navigating to the reading list
 */
export const MeterReadingForm: React.FC<MeterReadingFormProps> = ({
  onNavigateToList,
}) => {
  // Get data from stores
  const meterReadingsStore = useMeterReadingsEnhanced();
  const { selectedMeter } = useMeterSelection();

  // Initialize form state
  const [state, setState] = useState<MeterReadingFormState>({
    lastReading: null,
    graphData: [],
    selectedTimePeriod: 'today',
    selectedGraphType: 'consumption',
    isLoading: true,
    error: null,
  });

  // Store meter data separately
  const [meter, setMeter] = useState<Meter | null>(null);

  /**
   * Handle retry button click
   */
  const handleRetry = () => {
    setState((prev) => ({ ...prev, isLoading: true }));
  };

  /**
   * Fetch last reading when store data changes or store finishes loading
   */
  useEffect(() => {
    
    // If store is still loading, wait
    if (meterReadingsStore.loading) {
      setState((prev) => ({ ...prev, isLoading: true }));
      return;
    }
    
    // Store finished loading, process the reading
    try {
      const readings = meterReadingsStore.items;
      
      if (readings && readings.length > 0) {
        // Sort by created_at descending and get the first one
        const sortedReadings = [...readings].sort((a, b) => {
          const dateA = new Date((a as any).created_at).getTime();
          const dateB = new Date((b as any).created_at).getTime();
          return dateB - dateA;
        });
        
        const lastReading = sortedReadings[0] as any;
        
        // Build sections from flat data
        const sections: { [key: string]: any } = {
          'Voltage': {
            'Voltage A-N': {
              overall: lastReading.voltage_a_n || 0,
              phase1: lastReading.voltage_a_n || 0,
              phase2: null,
              phase3: null,
              unit: 'V'
            },
            'Voltage B-N': {
              overall: lastReading.voltage_b_n || 0,
              phase1: null,
              phase2: lastReading.voltage_b_n || 0,
              phase3: null,
              unit: 'V'
            },
            'Voltage C-N': {
              overall: lastReading.voltage_c_n || 0,
              phase1: null,
              phase2: null,
              phase3: lastReading.voltage_c_n || 0,
              unit: 'V'
            },
          },
          'Current': {
            'Current': {
              overall: lastReading.amperage || 0,
              phase1: lastReading.phase_amperage_a || 0,
              phase2: lastReading.phase_amperage_b || 0,
              phase3: lastReading.phase_amperage_c || 0,
              unit: 'A'
            },
          },
          'Power': {
            'Active Power': {
              overall: lastReading.kw || 0,
              phase1: lastReading.phase_kw_a || 0,
              phase2: lastReading.phase_kw_b || 0,
              phase3: lastReading.phase_kw_c || 0,
              unit: 'kW'
            },
          },
        };
        
        const convertedReading: MeterReading = {
          id: lastReading.meter_reading_id || '',
          meterElementId: lastReading.meter_element_id || '',
          timestamp: new Date(lastReading.created_at),
          frequency: parseFloat(lastReading.frequency) || 0,
          sections: sections,
        };
        
        setState((prev) => ({ ...prev, lastReading: convertedReading, isLoading: false }));
      } else {
        setState((prev) => ({ ...prev, isLoading: false }));
      }
    } catch (error) {
      console.error('[MeterReadingForm] Error:', error);
      const err = error instanceof Error ? error : new Error('Unknown error');
      setState((prev) => ({ ...prev, error: err, isLoading: false }));
    }
  }, [meterReadingsStore.items, meterReadingsStore.loading]);

  /**
   * Build meter object from store data
   */
  useEffect(() => {
    if (selectedMeter && meterReadingsStore.items && meterReadingsStore.items.length > 0) {
      const firstReading = meterReadingsStore.items[0] as any;
      const meterObj: Meter = {
        id: selectedMeter,
        driver: firstReading?.meter?.driver || 'N/A',
        description: firstReading?.meter?.description || 'N/A',
        serialNumber: firstReading?.meter?.serialNumber || 'N/A',
        elements: [],
        meterName: firstReading?.meter_name || firstReading?.meter?.name,
        elementName: firstReading?.element_name,
        elementNumber: firstReading?.element_number,
      };
      setMeter(meterObj);
    }
  }, [selectedMeter, meterReadingsStore.items]);

  // Render loading state
  if (state.isLoading && !state.lastReading) {
    return (
      <div className="meter-reading-form meter-reading-form--loading">
        <div className="loading-spinner">Loading meter reading...</div>
      </div>
    );
  }

  // Render error state
  if (state.error) {
    return (
      <div className="meter-reading-form meter-reading-form--error">
        <div className="error-message">
          <p>Error loading meter reading: {state.error.message}</p>
          <button type="button" onClick={handleRetry} className="btn btn-primary">
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Render empty state
  if (!state.lastReading) {
    return (
      <div className="meter-reading-form meter-reading-form--empty">
        <div className="empty-message">
          <p>No meter readings available for this element</p>
        </div>
      </div>
    );
  }

  // Render form with data
  return (
    <div className="meter-reading-form">
      <div className="meter-reading-form__header">
        <h1>Meter Reading</h1>
        {onNavigateToList && (
          <button
            type="button"
            onClick={onNavigateToList}
            className="btn btn-secondary"
            aria-label="View all readings for this meter element"
          >
            View All Readings
          </button>
        )}
      </div>

      <div className="meter-reading-form__content">
        {/* Meter Info Panel */}
        {meter && state.lastReading && (
          <section className="meter-reading-form__section meter-info-panel">
            <MeterInfoPanel meter={meter} reading={state.lastReading} />
          </section>
        )}

        {/* Reading Data Table */}
        {state.lastReading && (
          <section className="meter-reading-form__section reading-data-table">
            <h2>Reading Values</h2>
            <ReadingDataTable reading={state.lastReading} />
          </section>
        )}

        {/* Consumption Graph - TODO: Implement sub-component */}
        <section className="meter-reading-form__section consumption-graph">
          <h2>Consumption Trends</h2>
          {/* Sub-component will be rendered here */}
        </section>
      </div>
    </div>
  );
};

export default MeterReadingForm;
