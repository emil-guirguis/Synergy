/**
 * Meter Reading Management Page
 * 
 * Read-only view for meter readings
 * Uses EntityManagementPage but without form/create/edit functionality
 */


import React from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { MeterReadingList } from './MeterReadingList';
import { MeterReadingForm } from './MeterReadingForm';
import { DetailedMeterReadingView } from './DetailedMeterReadingView';
import { useMeterReadingsEnhanced } from './meterReadingsStore';
import { useMeterSelection } from '../../contexts/MeterSelectionContext';
import { useAuth } from '../../hooks/useAuth';
import { meterReadingService } from '../../services/meterReadingService';
import { adaptMeterReading, type MeterInfo, type MeterReadingData } from './meterReadingAdapter';

export const MeterReadingManagementPage: React.FC = () => {
  const store = useMeterReadingsEnhanced();
  const { setSelectedMeter, setSelectedElement } = useMeterSelection();
  const auth = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [gridType, setGridType] = React.useState<'simple' | 'baselist'>('simple');
  const [showForm, setShowForm] = React.useState(false);
  const [showDetailedView, setShowDetailedView] = React.useState(false);
  const [detailedReading, setDetailedReading] = React.useState<{ meterInfo: MeterInfo; reading: MeterReadingData } | null>(null);
  const [detailedViewLoading, setDetailedViewLoading] = React.useState(false);
  const [detailedViewError, setDetailedViewError] = React.useState<string | null>(null);
  const [virtualMeterData, setVirtualMeterData] = React.useState<any | null>(null);
  const [virtualViewLoading, setVirtualViewLoading] = React.useState(false);
  const [virtualViewError, setVirtualViewError] = React.useState<string | null>(null);

  const meterId = searchParams.get('meterId');
  const elementId = searchParams.get('elementId');
  const elementName = searchParams.get('elementName');
  const elementNumber = searchParams.get('elementNumber');
  const urlGridType = searchParams.get('gridType') as 'simple' | 'baselist' | null;
  const isVirtual = searchParams.get('virtual') === 'true';


  // Set context values from URL params and fetch readings
  React.useEffect(() => {
    
    if (meterId && auth.user?.client) {
      setSelectedMeter(meterId);
      if (elementId) {
        const parsedElementNumber = elementNumber ? parseInt(elementNumber) : undefined;
        setSelectedElement(elementId, elementName || undefined, parsedElementNumber);
      }
      
      // Set gridType from URL if provided
      if (urlGridType) {
        setGridType(urlGridType);
      }
      
      // NOTE: showForm is no longer used when gridType === 'simple'
      // The detailed view is now handled by the second useEffect
      setShowForm(false);
      
      const fetchParams = {
        tenantId: auth.user.client,
        meterId: meterId,
        meterElementId: elementId || undefined,
      };
      store.fetchItems(fetchParams);
    }
  }, [meterId, elementId, elementName, elementNumber, auth.user?.client, urlGridType]);

  /**
   * Fetch last meter reading when showing detailed view (favorite clicked)
   */
  React.useEffect(() => {
    
    const fetchLastReading = async () => {
      if (urlGridType === 'simple' && meterId && elementId && auth.user?.client) {
        setShowDetailedView(true);

        // Use pre-fetched data from router state (set by favorites click handler)
        const prefetched = (location.state as Record<string, unknown> | null)?.prefetchedReading;
        if (prefetched) {
          setDetailedReading(prefetched as { meterInfo: MeterInfo; reading: MeterReadingData });
          setDetailedViewLoading(false);
          setDetailedViewError(null);
          return;
        }

        setDetailedViewLoading(true);
        setDetailedViewError(null);

        try {
          const rawReading = await meterReadingService.getLastMeterReading(
            auth.user.client,
            meterId,
            elementId
          );

          const adaptedData = adaptMeterReading(rawReading, elementName || undefined);

          setDetailedReading(adaptedData);
          setDetailedViewLoading(false);
        } catch (error) {
          console.error('[MeterReadingManagementPage] Error fetching last reading:', error);
          setDetailedViewError(error instanceof Error ? error.message : 'Failed to load meter reading');
          setDetailedViewLoading(false);
        }
      } else {
        setShowDetailedView(false);
        setDetailedReading(null);
      }
    };
    
    fetchLastReading();
  }, [meterId, elementId, auth.user?.client, urlGridType]);

  /**
   * Fetch virtual meter data when virtual=true is in the URL
   */
  React.useEffect(() => {
    const fetchVirtualMeter = async () => {
      if (isVirtual && meterId && auth.user?.client) {
        // Use pre-fetched data from router state (set by favorites click handler)
        const prefetched = (location.state as Record<string, unknown> | null)?.prefetchedVirtualReading;
        if (prefetched) {
          setVirtualMeterData(prefetched);
          setVirtualViewLoading(false);
          setVirtualViewError(null);
          return;
        }

        setVirtualViewLoading(true);
        setVirtualViewError(null);
        setVirtualMeterData(null);
        try {
          const data = await meterReadingService.getVirtualMeterLastReading(auth.user.client, meterId);
          setVirtualMeterData(data);
        } catch (error) {
          setVirtualViewError(error instanceof Error ? error.message : 'Failed to load virtual meter');
        } finally {
          setVirtualViewLoading(false);
        }
      } else if (!isVirtual) {
        setVirtualMeterData(null);
        setVirtualViewError(null);
      }
    };
    fetchVirtualMeter();
  }, [isVirtual, meterId, auth.user?.client]);

  /**
   * Handle navigation to the meter reading list
   */
  const handleNavigateToList = React.useCallback(() => {
    const params = new URLSearchParams();
    if (meterId) params.set('meterId', meterId);
    if (elementId) params.set('elementId', elementId);
    if (elementName) params.set('elementName', elementName);
    if (elementNumber) params.set('elementNumber', elementNumber);
    params.set('gridType', 'baselist');
    navigate(`/meter-readings?${params.toString()}`);
  }, [meterId, elementId, elementName, elementNumber, navigate]);


  return (
    <div className="meter-reading-management-page">
      {isVirtual && meterId ? (
        <DetailedMeterReadingView
          meterInfo={{
            driver: 'Virtual',
            description: virtualMeterData?.meter_name || '',
            serialNumber: '',
          }}
          reading={{
            activeEnergyTotal: virtualMeterData?.total_kwh ?? 0,
            maximumDemandReal: 0,
            voltagePhaseA: 0, voltagePhaseB: 0, voltagePhaseC: 0,
            voltageAB: 0, voltageBC: 0, voltageCA: 0,
            currentPhaseA: 0, currentPhaseB: 0, currentPhaseC: 0, currentTotal: 0,
            powerPhaseA: 0, powerPhaseB: 0, powerPhaseC: 0, powerTotal: 0,
            apparentPowerPhaseA: 0, apparentPowerPhaseB: 0, apparentPowerPhaseC: 0, apparentPowerTotal: 0,
            reactivePowerPhaseA: 0, reactivePowerPhaseB: 0, reactivePowerPhaseC: 0, reactivePowerTotal: 0,
            powerFactorPhaseA: 0, powerFactorPhaseB: 0, powerFactorPhaseC: 0, powerFactorTotal: 0,
            frequency: 0,
            timestamp: virtualMeterData?.last_reading_date ? new Date(virtualMeterData.last_reading_date) : new Date(),
          }}
          loading={virtualViewLoading}
          error={virtualViewError}
          isVirtual={true}
          installationDate={virtualMeterData?.installation_date}
        />
      ) : showDetailedView && elementId ? (
        <>
          {detailedReading ? (
            <>
              <DetailedMeterReadingView
                meterInfo={detailedReading.meterInfo}
                reading={detailedReading.reading}
                loading={detailedViewLoading}
                error={detailedViewError}
                onViewAllReadings={handleNavigateToList}
              />
            </>
          ) : (
            <>
              <div className="detailed-view-loading">
                {detailedViewLoading ? (
                  <p>Loading meter reading...</p>
                ) : detailedViewError ? (
                  <div className="detailed-view-error">
                    <p>Error: {detailedViewError}</p>
                    <button onClick={handleNavigateToList}>View All Readings</button>
                  </div>
                ) : (
                  <p>Initializing...</p>
                )}
              </div>
            </>
          )}
        </>
      ) : showForm && elementId ? (
        <>
          <MeterReadingForm 
            meterElementId={elementId}
            onNavigateToList={handleNavigateToList}
          />
        </>
      ) : (
        <>
          <MeterReadingList gridType={gridType} onGridTypeChange={setGridType} />
        </>
      )}
    </div>
  );
};
