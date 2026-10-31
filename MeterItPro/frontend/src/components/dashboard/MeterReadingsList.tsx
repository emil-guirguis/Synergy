import React, { useState, useEffect, useCallback } from 'react';
import { BaseList } from '@meterit/framework-frontend/components/list/BaseList';
import { meterReadingService } from '../../services';
import type { DetailedMeterReading } from '../../types/entities';
import './MeterReadingsList.css';

interface MeterReadingsListProps {
  className?: string;
  showTitle?: boolean;
  maxItems?: number;
}

export const MeterReadingsList: React.FC<MeterReadingsListProps> = ({
  className = '',
  showTitle = true,
  maxItems = 10
}) => {
  const [readings, setReadings] = useState<DetailedMeterReading[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllColumns, setShowAllColumns] = useState(false);

  // Fetch latest meter readings
  const fetchReadings = useCallback(async (fetchAll = false) => {
    try {
      setLoading(true);
      setError(null);

      let data;
      if (fetchAll) {
        // Fetch all readings with pagination (get more data)
        const response = await meterReadingService.getMeterReadings({
          page: 1,
          pageSize: Math.max(maxItems * 2, 100), // Get at least 100 or double maxItems
          sortBy: 'timestamp',
          sortOrder: 'desc'
        });
        data = response.items;
      } else {
        // Fetch just the latest readings
        data = await meterReadingService.getLatestReadings();
      }

      // Sort by timestamp descending (newest first)
      const sortedData = data.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setReadings(sortedData.slice(0, maxItems));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch meter readings';
      console.error('❌ Error fetching meter readings:', err);
      console.error('❌ Error message:', errorMsg);
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  }, [maxItems]);

  // Handle refresh button click
  const handleRefreshClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    fetchReadings(true); // Always fetch all data on manual refresh
  }, [fetchReadings]);

  useEffect(() => {
    fetchReadings(true);
  }, [fetchReadings]);

  // Safe number check
  const isNum = (v: any): v is number => typeof v === 'number' && isFinite(v);

  // Format power factor as percentage (safe)
  const formatPowerFactor = (value: any): string => {
    if (!isNum(value)) return '—';
    return `${(value * 100).toFixed(1)}%`;
  };

  // Format number with units (safe)
  const formatValue = (value: any, unit: string, decimals: number = 1): string => {
    if (!isNum(value)) return '—';
    return `${value.toFixed(decimals)} ${unit}`;
  };

  // Format number with commas and units (safe)
  const formatValueWithCommas = (value: any, unit: string, decimals: number = 1): string => {
    if (!isNum(value)) return '—';
    return `${value.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${unit}`;
  };

  // Get quality indicator
  const getQualityIndicator = (quality: string): string => {
    switch (quality) {
      case 'good': return '✅';
      case 'estimated': return '⚠️';
      case 'questionable': return '❌';
      default: return '❓';
    }
  };

  // Define essential columns (shown by default)
  const essentialColumns = [
    {
      key: 'timestamp',
      label: 'Last Updated',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => (
        <div className="meter-readings__timestamp-cell">
          <div className="meter-readings__date">
            {new Date(reading.timestamp).toLocaleDateString()}
          </div>
          <div className="meter-readings__time">
            {new Date(reading.timestamp).toLocaleTimeString()}
          </div>
        </div>
      )
    },
    {
      key: 'deviceIP',
      label: 'Device IP',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.deviceIP || reading.ip || ''
    },
    {
      key: 'meterId',
      label: 'Meter ID',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => (
        <div className="meter-readings__meter-cell">
          <div className="meter-readings__meter-id">{reading.meterId}</div>
          <div className="meter-readings__meter-ip">{reading.ip}:{reading.port}</div>
        </div>
      )
    },
        {
      key: 'energy',
      label: 'Energy (modbus)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.energy ? formatValueWithCommas(reading.energy, 'Wh') : ''
    },
        {
      key: 'voltage',
      label: 'Voltage (modbus)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.voltage ? formatValue(reading.voltage, 'V') : ''
    },
    {
      key: 'kWh',
      label: 'Energy (kWh)',
      sortable: true,
      align: 'right' as const,
      render: (_value: any, reading: DetailedMeterReading) => (
        <span className="meter-readings__energy">
          {formatValue(reading.kWh, 'kWh', 1)}
        </span>
      )
    },
    {
      key: 'kW',
      label: 'Power (kW)',
      sortable: true,
      align: 'right' as const,
      render: (_value: any, reading: DetailedMeterReading) => (
        <div className="meter-readings__power-cell">
          <div className="meter-readings__current-power">{formatValue(reading.kW, 'kW', 1)}</div>
          <div className="meter-readings__peak-power">Peak: {formatValue(reading.kWpeak, 'kW', 1)}</div>
        </div>
      )
    },
    {
      key: 'V',
      label: 'Voltage',
      sortable: true,
      align: 'right' as const,
      render: (_value: any, reading: DetailedMeterReading) => (
        <span className="meter-readings__voltage">
          {formatValue(reading.V, 'V', 1)}
        </span>
      )
    },
    {
      key: 'A',
      label: 'Current',
      sortable: true,
      align: 'right' as const,
      render: (_value: any, reading: DetailedMeterReading) => (
        <span className="meter-readings__current">
          {formatValue(reading.A, 'A', 1)}
        </span>
      )
    },
    {
      key: 'dPF',
      label: 'Power Factor',
      sortable: true,
      align: 'right' as const,
      render: (_value: any, reading: DetailedMeterReading) => (
        <div className="meter-readings__pf-cell">
          <div className="meter-readings__pf-value">{formatPowerFactor(reading.dPF)}</div>
          <div className="meter-readings__pf-channel">Ch: {reading.dPFchannel}</div>
        </div>
      )
    },
    {
      key: 'quality',
      label: 'Quality',
      sortable: true,
      align: 'center' as const,
      render: (_value: any, reading: DetailedMeterReading) => (
        <div className="meter-readings__quality-cell">
          <span className="meter-readings__quality-indicator">
            {getQualityIndicator(reading.quality || 'good')}
          </span>
          <span className="meter-readings__quality-text">
            {(reading.quality || 'good').charAt(0).toUpperCase() + (reading.quality || 'good').slice(1)}
          </span>
        </div>
      )
    },
  ];

  // Define additional columns (shown when expanded)
  const additionalColumns = [
    {
      key: 'source',
      label: 'Source',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.source ?? ''
    },

    {
      key: 'current',
      label: 'Current (modbus)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.current ? formatValue(reading.current, 'A') : ''
    },
    {
      key: 'power',
      label: 'Power (modbus)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.power ? formatValue(reading.power, 'W') : ''
    },

    {
      key: 'frequency',
      label: 'Frequency (modbus)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.frequency ? formatValue(reading.frequency, 'Hz') : ''
    },
    {
      key: 'powerFactor',
      label: 'Power Factor (modbus)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.powerFactor ? formatPowerFactor(reading.powerFactor) : ''
    },
    {
      key: 'phaseAVoltage',
      label: 'Phase A Voltage',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseAVoltage ? formatValue(reading.phaseAVoltage, 'V') : ''
    },
    {
      key: 'phaseBVoltage',
      label: 'Phase B Voltage',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseBVoltage ? formatValue(reading.phaseBVoltage, 'V') : ''
    },
    {
      key: 'phaseCVoltage',
      label: 'Phase C Voltage',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseCVoltage ? formatValue(reading.phaseCVoltage, 'V') : ''
    },
    {
      key: 'phaseACurrent',
      label: 'Phase A Current',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseACurrent ? formatValue(reading.phaseACurrent, 'A') : ''
    },
    {
      key: 'phaseBCurrent',
      label: 'Phase B Current',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseBCurrent ? formatValue(reading.phaseBCurrent, 'A') : ''
    },
    {
      key: 'phaseCCurrent',
      label: 'Phase C Current',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseCCurrent ? formatValue(reading.phaseCCurrent, 'A') : ''
    },
    {
      key: 'phaseAPower',
      label: 'Phase A Power',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseAPower ? formatValue(reading.phaseAPower, 'W') : ''
    },
    {
      key: 'phaseBPower',
      label: 'Phase B Power',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseBPower ? formatValue(reading.phaseBPower, 'W') : ''
    },
    {
      key: 'phaseCPower',
      label: 'Phase C Power',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseCPower ? formatValue(reading.phaseCPower, 'W') : ''
    },
    {
      key: 'lineToLineVoltageAB',
      label: 'Line Voltage AB',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.lineToLineVoltageAB ? formatValue(reading.lineToLineVoltageAB, 'V') : ''
    },
    {
      key: 'lineToLineVoltageBC',
      label: 'Line Voltage BC',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.lineToLineVoltageBC ? formatValue(reading.lineToLineVoltageBC, 'V') : ''
    },
    {
      key: 'lineToLineVoltageCA',
      label: 'Line Voltage CA',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.lineToLineVoltageCA ? formatValue(reading.lineToLineVoltageCA, 'V') : ''
    },
    {
      key: 'totalActivePower',
      label: 'Total Active Power',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.totalActivePower ? formatValue(reading.totalActivePower, 'W') : ''
    },
    {
      key: 'totalReactivePower',
      label: 'Total Reactive Power',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.totalReactivePower ? formatValue(reading.totalReactivePower, 'VAR') : ''
    },
    {
      key: 'totalApparentPower',
      label: 'Total Apparent Power',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.totalApparentPower ? formatValue(reading.totalApparentPower, 'VA') : ''
    },
    {
      key: 'totalActiveEnergyWh',
      label: 'Total Active Energy',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.totalActiveEnergyWh ? formatValue(reading.totalActiveEnergyWh, 'Wh') : ''
    },
    {
      key: 'totalReactiveEnergyVARh',
      label: 'Total Reactive Energy',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.totalReactiveEnergyVARh ? formatValue(reading.totalReactiveEnergyVARh, 'VARh') : ''
    },
    {
      key: 'totalApparentEnergyVAh',
      label: 'Total Apparent Energy',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.totalApparentEnergyVAh ? formatValue(reading.totalApparentEnergyVAh, 'VAh') : ''
    },
    {
      key: 'frequencyHz',
      label: 'Frequency (Hz)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.frequencyHz ? formatValue(reading.frequencyHz, 'Hz') : ''
    },
    {
      key: 'temperatureC',
      label: 'Temperature',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.temperatureC ? formatValue(reading.temperatureC, '°C') : ''
    },
    {
      key: 'humidity',
      label: 'Humidity',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.humidity ? formatValue(reading.humidity, '%') : ''
    },
    {
      key: 'neutralCurrent',
      label: 'Neutral Current',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.neutralCurrent ? formatValue(reading.neutralCurrent, 'A') : ''
    },
    {
      key: 'phaseAPowerFactor',
      label: 'Phase A PF',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseAPowerFactor ? formatPowerFactor(reading.phaseAPowerFactor) : ''
    },
    {
      key: 'phaseBPowerFactor',
      label: 'Phase B PF',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseBPowerFactor ? formatPowerFactor(reading.phaseBPowerFactor) : ''
    },
    {
      key: 'phaseCPowerFactor',
      label: 'Phase C PF',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.phaseCPowerFactor ? formatPowerFactor(reading.phaseCPowerFactor) : ''
    },
    {
      key: 'voltageThd',
      label: 'Voltage THD',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.voltageThd ? formatValue(reading.voltageThd, '%') : ''
    },
    {
      key: 'currentThd',
      label: 'Current THD',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.currentThd ? formatValue(reading.currentThd, '%') : ''
    },
    {
      key: 'maxDemandKW',
      label: 'Max Demand (kW)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.maxDemandKW ? formatValue(reading.maxDemandKW, 'kW') : ''
    },
    {
      key: 'maxDemandKVAR',
      label: 'Max Demand (kVAR)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.maxDemandKVAR ? formatValue(reading.maxDemandKVAR, 'kVAR') : ''
    },
    {
      key: 'maxDemandKVA',
      label: 'Max Demand (kVA)',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.maxDemandKVA ? formatValue(reading.maxDemandKVA, 'kVA') : ''
    },
    {
      key: 'voltageUnbalance',
      label: 'Voltage Unbalance',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.voltageUnbalance ? formatValue(reading.voltageUnbalance, '%') : ''
    },
    {
      key: 'currentUnbalance',
      label: 'Current Unbalance',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.currentUnbalance ? formatValue(reading.currentUnbalance, '%') : ''
    },
    {
      key: 'communicationStatus',
      label: 'Comm Status',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => (
        <span className={`status-badge status-badge--${reading.communicationStatus === 'ok' ? 'success' : 'error'}`}>
          {reading.communicationStatus || 'unknown'}
        </span>
      )
    },
    {
      key: 'deviceModel',
      label: 'Device Model',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.deviceModel || ''
    },
    {
      key: 'firmwareVersion',
      label: 'Firmware',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.firmwareVersion || ''
    },
    {
      key: 'serial_number',
      label: 'Serial Number',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => reading.serial_number || ''
    },
    {
      key: 'alarmStatus',
      label: 'Alarms',
      sortable: true,
      render: (_value: any, reading: DetailedMeterReading) => (
        <span className={`status-badge status-badge--${reading.alarmStatus === 'active' ? 'warning' : 'success'}`}>
          {reading.alarmStatus || 'inactive'}
        </span>
      )
    }
  ];

  // Combine columns based on user preference
  const columns = showAllColumns ? [...essentialColumns, ...additionalColumns] : essentialColumns;

  if (loading) {
    return (
      <div className={`meter-readings-list ${className}`}>
        {showTitle && <h3 className="meter-readings-list__title">Meter Readings</h3>}
        <div className="meter-readings-list__loading">
          <div className="meter-readings-list__spinner"></div>
          <p>Loading meter readings...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`meter-readings-list ${className}`}>
        {showTitle && <h3 className="meter-readings-list__title">Latest Meter Readings</h3>}
        <div className="meter-readings-list__error">
          <p>Error: {error}</p>
          <button
            type="button"
            className="meter-readings-list__retry-btn"
            onClick={(e) => {
              e.preventDefault();
              fetchReadings(false);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`meter-readings-list ${className}`}>
      <BaseList
        title={showTitle ? "Latest Meter Readings" : undefined}
        data={readings}
        columns={columns}
        loading={loading}
        error={error || undefined}
        striped
        hoverable
        emptyMessage="No meter readings available"
        toolbarContent={
          <div className="meter-readings-list__header-actions">
            <button
              type="button"
              className="meter-readings-list__toggle-btn"
              onClick={() => setShowAllColumns(!showAllColumns)}
              title={showAllColumns ? 'Show essential columns only' : 'Show all columns'}
            >
              {showAllColumns ? '📋 Show Less' : '📊 Show All Columns'}
            </button>
            <button
              type="button"
              className="meter-readings-list__refresh-btn"
              onClick={handleRefreshClick}
              disabled={loading}
              title="Refresh all meter readings from database"
            >
              {loading ? (
                <>
                  <span className="meter-readings-list__refresh-spinner">⟳</span>
                  Refreshing...
                </>
              ) : (
                <>
                  🔄 Refresh
                </>
              )}
            </button>
          </div>
        }
      />
    </div>
  );
};