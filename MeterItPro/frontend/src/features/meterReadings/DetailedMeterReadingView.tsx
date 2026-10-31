import React, { useState, useEffect, useMemo } from 'react';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import { FormControl, InputLabel, Select, MenuItem, IconButton } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useMeterSelection } from '../../contexts/MeterSelectionContext';
import { useAuth } from '../../hooks/useAuth';
import { ConsumptionGraph } from './ConsumptionGraph';
import { DemandGraph } from './DemandGraph';
import { meterService, formatItemLabel, type SelectedItem } from '../../services/meterService';
import { meterReadingService } from '../../services/meterReadingService';
import { GraphControls, defaultGraphControls, type GraphControlsValue } from '../../components/shared/GraphControls';
import { getChartDateRange } from '../../components/shared/chartUtils';
import './DetailedMeterReadingView.css';

interface MeterInfo {
  driver: string;
  description: string;
  serialNumber: string;
}

interface MeterReadingData {
  activeEnergyTotal: number;
  maximumDemandReal: number;
  voltagePhaseA: number;
  voltagePhaseB: number;
  voltagePhaseC: number;
  voltageAB: number;
  voltageBC: number;
  voltageCA: number;
  currentPhaseA: number;
  currentPhaseB: number;
  currentPhaseC: number;
  currentTotal: number;
  powerPhaseA: number;
  powerPhaseB: number;
  powerPhaseC: number;
  powerTotal: number;
  apparentPowerPhaseA: number;
  apparentPowerPhaseB: number;
  apparentPowerPhaseC: number;
  apparentPowerTotal: number;
  reactivePowerPhaseA: number;
  reactivePowerPhaseB: number;
  reactivePowerPhaseC: number;
  reactivePowerTotal: number;
  powerFactorPhaseA: number;
  powerFactorPhaseB: number;
  powerFactorPhaseC: number;
  powerFactorTotal: number;
  frequency: number;
  timestamp: Date;
}

interface DetailedMeterReadingViewProps {
  meterInfo: MeterInfo;
  reading: MeterReadingData;
  loading?: boolean;
  error?: string | null;
  onViewAllReadings?: () => void;
  isVirtual?: boolean;
  installationDate?: string | null;
}

export const DetailedMeterReadingView: React.FC<DetailedMeterReadingViewProps> = ({
  meterInfo,
  reading,
  loading = false,
  error = null,
  onViewAllReadings,
  isVirtual = false,
  installationDate,
}) => {
  const [controls, setControls] = useState<GraphControlsValue>(defaultGraphControls());
  const [graphType, setGraphType] = useState<'consumption' | 'demand'>('consumption');
  const [offset, setOffset] = useState(0);
  const [virtualComponents, setVirtualComponents] = useState<SelectedItem[]>([]);
  const [checkedComponents, setCheckedComponents] = useState<Set<string>>(new Set());
  const [overrideOperations, setOverrideOperations] = useState<Map<string, '+' | '-'>>(new Map());
  const [componentKwh, setComponentKwh] = useState<Map<number, number>>(new Map());
  // Only the setter is read; the flag itself was used by a removed debug log.
  const [, setComponentKwhLoaded] = useState(false);

  const { selectedMeter, selectedElement } = useMeterSelection();

  useEffect(() => { setOffset(0); }, [controls.timePeriod]);
  const { user } = useAuth();

  useEffect(() => {
    if (!isVirtual || !selectedMeter) return;
    setOverrideOperations(new Map());
    meterService.getVirtualMeterConfig(selectedMeter)
      .then((items) => {
        setVirtualComponents(items);
        setCheckedComponents(new Set(items.map((item) => item.id)));
      })
      .catch(() => setVirtualComponents([]));
  }, [isVirtual, selectedMeter]);

  useEffect(() => {
    if (!isVirtual || !selectedMeter) return;
    setComponentKwhLoaded(false);
    meterReadingService.getVirtualComponentsLast(selectedMeter)
      .then((rows) => {
        const map = new Map<number, number>();
        rows.forEach((r) => map.set(Number(r.select_meter_element_id), Number(r.kwh)));
        setComponentKwh(map);
        setComponentKwhLoaded(true);
      })
      .catch((err) => {
        console.error('[VirtualMeter] virtual-components-last error:', err);
        setComponentKwh(new Map());
        setComponentKwhLoaded(true);
      });
  }, [isVirtual, selectedMeter]);

  const excludeIds = useMemo(() => {
    return virtualComponents
      .filter((item) => !checkedComponents.has(item.id))
      .map((item) => item.selectionType === 'element' ? item.meter_element_id : item.meter_id);
  }, [virtualComponents, checkedComponents]);

  // Overrides that differ from the stored operation — passed to graph API
  const graphOperationOverrides = useMemo(() => {
    if (!isVirtual || overrideOperations.size === 0) return undefined;
    const result = new Map<number, '+' | '-'>();
    virtualComponents.forEach((item) => {
      const override = overrideOperations.get(item.id);
      if (override && override !== item.operation) {
        const elementId = item.selectionType === 'element' ? Number(item.meter_element_id) : Number(item.meter_id);
        result.set(elementId, override);
      }
    });
    return result.size > 0 ? result : undefined;
  }, [isVirtual, overrideOperations, virtualComponents]);

  const displayTotal = useMemo(() => {
    if (!isVirtual || componentKwh.size === 0) return reading.activeEnergyTotal;
    return virtualComponents
      .filter((item) => checkedComponents.has(item.id))
      .reduce((sum, item) => {
        const elementId = item.selectionType === 'element' ? Number(item.meter_element_id) : Number(item.meter_id);
        // componentKwh stores sign-adjusted values from API; recover absolute kWh
        const signedKwh = componentKwh.get(elementId) ?? 0;
        const absKwh = item.operation === '-' ? -signedKwh : signedKwh;
        const effectiveOp = overrideOperations.get(item.id) ?? item.operation;
        return sum + (effectiveOp === '-' ? -absKwh : absKwh);
      }, 0);
  }, [isVirtual, virtualComponents, checkedComponents, componentKwh, overrideOperations, reading.activeEnergyTotal]);

  const handleOperationToggle = (itemId: string, currentEffectiveOp: '+' | '-', index: number) => {
    if (index === 0) return; // first item is always '+'
    const newOp: '+' | '-' = currentEffectiveOp === '+' ? '-' : '+';
    setOverrideOperations((prev) => {
      const next = new Map(prev);
      next.set(itemId, newOp);
      return next;
    });
  };

  const graphSubtitle = useMemo(() => {
    const { startDate, endDate } = getChartDateRange(controls.timePeriod, offset);
    const tp = controls.timePeriod;
    if (tp === 'today') {
      return startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
    if (tp === 'weekly') {
      return `Week of ${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    if (tp === 'monthly') {
      return startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    if (tp === 'yearly') {
      return String(startDate.getFullYear());
    }
    return `${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}`;
  }, [controls.timePeriod, offset]);

  const canGoForward = offset < 0;

  const formatNumber = (value: number | string | null | undefined, decimals: number = 2): string => {
    if (value === null || value === undefined) return '0.00';
    const num = Number(value);
    if (isNaN(num)) return '0.00';
    return num.toFixed(decimals);
  };

  if (loading) return <div className="detailed-reading-view--loading">Loading meter reading...</div>;
  if (error) return <div className="detailed-reading-view--error">Error: {error}</div>;

  return (
    <div className="detailed-reading-view">
      {/* Main Content */}
      <div className={`main-content${isVirtual ? ' main-content--virtual' : ''}`}>
        {/* Left: Meter Information */}
        <div className="meter-info-card">
          <div className="info-row">
            <span className="info-label">Description</span>
            <span className="info-value info-value--bold">{meterInfo.description}</span>
          </div>
          {!isVirtual && (
            <div className="info-row">
              <span className="info-label">Serial Number</span>
              <span className="info-value">{meterInfo.serialNumber}</span>
            </div>
          )}
          {isVirtual && installationDate && (
            <div className="info-row">
              <span className="info-label">Installation Date</span>
              <span className="info-value">
                {new Date(installationDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          )}
          <div className="info-row">
            <span className="info-label">Reading Date</span>
            <span className="info-value">
              {reading.timestamp ? new Date(reading.timestamp).toLocaleString() : 'N/A'}
            </span>
          </div>
          <hr className="meter-info-divider" />
          <div className="info-row">
            <span className="total-label">Total kWh</span>
            <span className="total-value">{formatNumber(displayTotal)} <span className="total-unit">kWh</span></span>
          </div>
          {!isVirtual && (
            <>
              <div className="info-row">
                <span className="total-label">Peak Demand</span>
                <span className="total-value">{formatNumber(reading.maximumDemandReal)} <span className="total-unit">kW</span></span>
              </div>
              <div className="info-row">
                <span className="total-label">Frequency</span>
                <span className="total-value">{formatNumber(reading.frequency)} <span className="total-unit">Hz</span></span>
              </div>
            </>
          )}

          {onViewAllReadings && (
            <div className="meter-info-card-actions">
              <button
                type="button"
                className="view-all-readings-btn"
                onClick={onViewAllReadings}
              >
                View All Readings
              </button>
            </div>
          )}
        </div>

        {/* Right Column: Virtual components list OR Phase Table */}
        {isVirtual && (
          <div className="meter-info-card virtual-components-card">
            <div className={`virtual-components-list${virtualComponents.length > 4 ? ' virtual-components-list--columns' : ''}`}>
              {virtualComponents.length === 0 ? (
                <span className="info-value info-value--muted">No components configured</span>
              ) : (
                virtualComponents.map((item, index) => {
                  const effectiveOp = overrideOperations.get(item.id) ?? item.operation;
                  const isOverridden = overrideOperations.has(item.id) && overrideOperations.get(item.id) !== item.operation;
                  return (
                  <div key={item.id} className="virtual-component-item">
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={checkedComponents.has(item.id)}
                          onChange={() => {
                            setCheckedComponents((prev) => {
                              const next = new Set(prev);
                              if (next.has(item.id)) {
                                next.delete(item.id);
                              } else {
                                next.add(item.id);
                              }
                              return next;
                            });
                          }}
                          size="small"
                          sx={{ py: 0.25, pl: 0.5, pr: 0.75 }}
                        />
                      }
                      label={
                        <span className="virtual-component-label">
                          <button
                            type="button"
                            className={[
                              'virtual-component-op',
                              `virtual-component-op--${effectiveOp === '-' ? 'minus' : 'plus'}`,
                              index === 0 ? 'virtual-component-op--fixed' : 'virtual-component-op--toggle',
                              isOverridden ? 'virtual-component-op--overridden' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={(e) => { e.preventDefault(); handleOperationToggle(item.id, effectiveOp, index); }}
                            title={index === 0 ? 'First item is always added (+)' : `Click to ${effectiveOp === '+' ? 'subtract' : 'add'}`}
                            disabled={index === 0}
                          >
                            {effectiveOp === '-' ? '−' : '+'}
                          </button>
                          {formatItemLabel(item)}
                        </span>
                      }
                      sx={{ margin: 0, '& .MuiFormControlLabel-label': { fontSize: 14, color: '#333' } }}
                    />
                  </div>
                  );
                })
              )}
            </div>
          </div>
        )}
        {!isVirtual && <div className="right-column">
          <div className="phase-data-section">
            <table className="phase-data-table">
              <thead>
                <tr>
                  <th className="metric-header"></th>
                  <th>Overall</th>
                  <th>Phase 1</th>
                  <th>Phase 2</th>
                  <th>Phase 3</th>
                  <th className="unit-header">Unit</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="metric-name">Phase Voltage</td>
                  <td>{formatNumber((reading.voltagePhaseA + reading.voltagePhaseB + reading.voltagePhaseC) / 3)}</td>
                  <td>{formatNumber(reading.voltagePhaseA)}</td>
                  <td>{formatNumber(reading.voltagePhaseB)}</td>
                  <td>{formatNumber(reading.voltagePhaseC)}</td>
                  <td className="unit">V</td>
                </tr>
                <tr>
                  <td className="metric-name">Line Voltage</td>
                  <td>{formatNumber((reading.voltageAB + reading.voltageBC + reading.voltageCA) / 3)}</td>
                  <td>{formatNumber(reading.voltageAB)}</td>
                  <td>{formatNumber(reading.voltageBC)}</td>
                  <td>{formatNumber(reading.voltageCA)}</td>
                  <td className="unit">V</td>
                </tr>
                <tr>
                  <td className="metric-name">Current</td>
                  <td>{formatNumber(reading.currentTotal)}</td>
                  <td>{formatNumber(reading.currentPhaseA)}</td>
                  <td>{formatNumber(reading.currentPhaseB)}</td>
                  <td>{formatNumber(reading.currentPhaseC)}</td>
                  <td className="unit">A</td>
                </tr>
                <tr>
                  <td className="metric-name">Power</td>
                  <td>{formatNumber(reading.powerTotal)}</td>
                  <td>{formatNumber(reading.powerPhaseA)}</td>
                  <td>{formatNumber(reading.powerPhaseB)}</td>
                  <td>{formatNumber(reading.powerPhaseC)}</td>
                  <td className="unit">kW</td>
                </tr>
                <tr>
                  <td className="metric-name">Apparent Power</td>
                  <td>{formatNumber(reading.apparentPowerTotal)}</td>
                  <td>{formatNumber(reading.apparentPowerPhaseA)}</td>
                  <td>{formatNumber(reading.apparentPowerPhaseB)}</td>
                  <td>{formatNumber(reading.apparentPowerPhaseC)}</td>
                  <td className="unit">kVA</td>
                </tr>
                <tr>
                  <td className="metric-name">Reactive Power</td>
                  <td>{formatNumber(reading.reactivePowerTotal)}</td>
                  <td>{formatNumber(reading.reactivePowerPhaseA)}</td>
                  <td>{formatNumber(reading.reactivePowerPhaseB)}</td>
                  <td>{formatNumber(reading.reactivePowerPhaseC)}</td>
                  <td className="unit">kVAr</td>
                </tr>
                <tr>
                  <td className="metric-name">Power Factor</td>
                  <td>{formatNumber(reading.powerFactorTotal)}</td>
                  <td>{formatNumber(reading.powerFactorPhaseA)}</td>
                  <td>{formatNumber(reading.powerFactorPhaseB)}</td>
                  <td>{formatNumber(reading.powerFactorPhaseC)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>}
      </div>

      {/* Consumption Graphs Section */}
      <div className="consumption-graphs-section">
        <div className="graph-controls-row">
          <div className="graphs-header">
            <h2 className="section-title">Consumption Graphs</h2>
            <h3 className="graph-subtitle">{graphSubtitle}</h3>
          </div>
          <IconButton size="small" onClick={() => setOffset(o => o - 1)} title="Previous period">
            <ChevronLeftIcon />
          </IconButton>
          <IconButton size="small" onClick={() => setOffset(o => o + 1)} disabled={!canGoForward} title="Next period">
            <ChevronRightIcon />
          </IconButton>
          <GraphControls
            value={controls}
            onChange={setControls}
            supportedVisualizations={['bar', 'line']}
          />
          <FormControl size="small" sx={{ minWidth: 140, ml: 1.5 }}>
            <InputLabel>Data Type</InputLabel>
            <Select
              label="Data Type"
              value={graphType}
              onChange={(e) => setGraphType(e.target.value as 'consumption' | 'demand')}
            >
              <MenuItem value="consumption">Consumption</MenuItem>
              <MenuItem value="demand">Demand</MenuItem>
            </Select>
          </FormControl>
        </div>

        <div className="graph-area">
          {graphType === 'consumption' && selectedMeter && (isVirtual || selectedElement) && user?.client ? (
            <ConsumptionGraph
              meterId={selectedMeter}
              meterElementId={selectedElement || ''}
              tenantId={user.client}
              timePeriod={controls.timePeriod}
              offset={offset}
              chartType={controls.visualizationType === 'line' ? 'line' : 'bar'}
              isVirtual={isVirtual}
              excludeIds={isVirtual ? excludeIds : undefined}
              operationOverrides={isVirtual ? graphOperationOverrides : undefined}
            />
          ) : graphType === 'demand' && selectedMeter && (isVirtual || selectedElement) && user?.client ? (
            <DemandGraph
              meterId={selectedMeter}
              meterElementId={selectedElement || ''}
              tenantId={user.client}
              timePeriod={controls.timePeriod}
              offset={offset}
              chartType={controls.visualizationType === 'bar' ? 'bar' : 'line'}
              isVirtual={isVirtual}
              excludeIds={isVirtual ? excludeIds : undefined}
              operationOverrides={isVirtual ? graphOperationOverrides : undefined}
            />
          ) : (
            <div className="graph-placeholder">
              <p>Unable to load chart data</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DetailedMeterReadingView;