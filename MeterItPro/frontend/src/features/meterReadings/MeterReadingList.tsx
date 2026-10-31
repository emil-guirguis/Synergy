import React from 'react';
import { useMeterReadingsEnhanced } from './meterReadingsStore';
import { useAuth } from '../../hooks/useAuth';
import { useMeterSelection } from '../../contexts/MeterSelectionContext';
import { SimpleMeterReadingGrid } from './SimpleMeterReadingGrid';
import { MeterReadingExportButtons } from '../../components/MeterReadingExportButtons';
import { registerMappingService } from '../../services/registerMappingService';
import './MeterReadingList.css';

interface MeterReadingListProps {
  onMeterReadingSelect?: (reading: any) => void;
  gridType?: 'simple' | 'baselist';
  onGridTypeChange?: (type: 'simple' | 'baselist') => void;
}

export const MeterReadingList: React.FC<MeterReadingListProps> = ({
  gridType = 'simple',
  onGridTypeChange,
}) => {
  const meterReadings = useMeterReadingsEnhanced();
  const auth = useAuth();
  const { selectedMeter, selectedElement, selectedMeterName, selectedElementName } = useMeterSelection();

  /**
   * Initialize register mapping service on component mount
   */
  React.useEffect(() => {
    registerMappingService.initialize().catch((err) => {
      console.warn('Failed to initialize register mapping service:', err);
    });
  }, []);

  /**
   * Check for missing tenantId
   */
  const tenantError = React.useMemo(() => {
    if (!auth.user?.client) {
      return 'Unable to load meter readings - tenant information missing. Please log out and log back in.';
    }
    return null;
  }, [auth.user?.client]);

  /**
   * Memoized filtered data based on selected meter and element
   */
  const filteredData = React.useMemo(() => {
    if (meterReadings.loading) {
      return meterReadings.items;
    }

    if (!selectedMeter) {
      return meterReadings.items;
    }

    // Filter by selected meter and optionally by selected element
    const filtered = meterReadings.items.filter((reading: any) => {
      const readingMeterId = String(reading.meter_id || '');
      const meterMatch = readingMeterId === selectedMeter;

      if (!selectedElement) {
        return meterMatch;
      }

      const readingElementId = String(reading.meter_element_id || '');
      return meterMatch && readingElementId === selectedElement;
    });

    return filtered;
  }, [meterReadings.items, meterReadings.loading, selectedMeter, selectedElement]);

  /**
   * Memoized title - display favorite caption if available, otherwise just "Meter Readings"
   */
  const title = React.useMemo(() => {

    if (!selectedMeter) {
      return 'Meter Readings';
    }

    // If we have an element name (which comes from favorite caption), use it
    if (selectedElement && selectedElementName) {
      return `Meter Readings - ${selectedElementName}`;
    }

    return 'Meter Readings';
  }, [selectedMeter, selectedElement, selectedElementName]);



  /**
   * Determine which error to display
   */
  const displayError = tenantError || meterReadings.error;

  /**
   * Handle retry button click
   */
  const handleRetry = () => {
    meterReadings.clearError();
    meterReadings.fetchItems({
      tenantId: auth.user?.client,
      meterId: selectedMeter,
      meterElementId: selectedElement,
    });
  };

  /**
   * Handle grid type change
   */
  const handleGridTypeChange = (type: 'simple' | 'baselist') => {
    onGridTypeChange?.(type);
  };

  return (
    <div className="meter-reading-list">
      <div className="meter-reading-list__header">
        <h2>{title}</h2>
        <MeterReadingExportButtons
          filteredData={filteredData as any}
          selectedMeterName={selectedMeterName || undefined}
          selectedElementName={selectedElementName || undefined}
          loading={meterReadings.loading}
        />
      </div>

      {displayError && (
        <div className="meter-reading-list__error">
          <p>{displayError}</p>
          <button onClick={handleRetry} className="meter-reading-list__retry-btn" type="button">
            Retry
          </button>
        </div>
      )}

      {!displayError && (
        <SimpleMeterReadingGrid
          data={filteredData as any}
          loading={meterReadings.loading}
          error={undefined}
          page={meterReadings.page}
          pageSize={meterReadings.pageSize}
          total={meterReadings.total}
          totalPages={meterReadings.totalPages}
          onPageChange={meterReadings.goToPage}
          onPageSizeChange={meterReadings.setPageSize}
        />
      )}
    </div>
  );
};
