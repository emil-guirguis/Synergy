import React, { useState, useEffect, useCallback } from 'react';
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import apiClient from '../../services/apiClient';
import './DeviceRegisterChecklist.css';

export interface Register {
  id: number;
  register: string;
  name: string;
  unit: string;
  field_name: string;
}

export interface DeviceRegister {
  id: number;
  device_id: number;
  register_id: number;
  register?: Register;
}

interface DeviceRegisterChecklistProps {
  deviceId: number | null;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label?: string;
}

/**
 * DeviceRegisterChecklist
 *
 * Reusable component for selecting registers from a specific device.
 * Features:
 * - Fetches device-scoped registers from /api/devices/:deviceId/registers
 * - Collapsible section (collapsed by default)
 * - Shows selected register names as chips in header
 * - Checkbox list UI matching RegisterSelector patterns
 *
 * Used in: Reports, Notifications, Dashboard forms
 */
export const DeviceRegisterChecklist: React.FC<DeviceRegisterChecklistProps> = ({
  deviceId,
  value = [],
  onChange,
  disabled = false,
  label = 'Registers',
}) => {
  const [registers, setRegisters] = useState<DeviceRegister[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const loadRegisters = useCallback(async () => {

    if (!deviceId) {
      setRegisters([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get(`/meters/${deviceId}/registers`);
      setRegisters(response.data.data || []);
    } catch (err) {
      console.error('DeviceRegisterChecklist: API error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to load registers';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    loadRegisters();
  }, [deviceId, loadRegisters]);

  const handleToggle = (_registerId: number, fieldName: string) => {
    const newValue = value.includes(fieldName)
      ? value.filter(v => v !== fieldName)
      : [...value, fieldName];
    onChange(newValue);
  };

  // Get selected register names to display in header (using field_names)
  const selectedRegisterNames = registers
    .filter(dr => dr.register?.field_name && value.includes(dr.register.field_name))
    .map(dr => dr.register?.name || 'Unknown');

  return (
    <div className="device-register-checklist">
      {/* Collapsible Header */}
      <button
        type="button"
        className={`device-register-checklist__header ${isOpen ? 'device-register-checklist__header--open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled || !deviceId}
      >
        <div className="device-register-checklist__header-content">
          <span className="device-register-checklist__label">{label}</span>

          {/* Selected registers as chips in header */}
          {selectedRegisterNames.length > 0 && (
            <div className="device-register-checklist__selected-chips">
              {selectedRegisterNames.slice(0, 2).map((name, idx) => (
                <span key={idx} className="device-register-checklist__chip">
                  {name}
                </span>
              ))}
              {selectedRegisterNames.length > 2 && (
                <span className="device-register-checklist__chip device-register-checklist__chip--more">
                  +{selectedRegisterNames.length - 2} more
                </span>
              )}
            </div>
          )}
        </div>

        <ExpandMoreIcon
          className={`device-register-checklist__chevron ${isOpen ? 'device-register-checklist__chevron--open' : ''}`}
        />
      </button>

      {/* Collapsible Body */}
      {isOpen && (
        <div className="device-register-checklist__body">
          {error && (
            <div className="device-register-checklist__error">{error}</div>
          )}

          {loading ? (
            <div className="device-register-checklist__loading">Loading registers...</div>
          ) : registers.length === 0 ? (
            <div className="device-register-checklist__empty">
              {!deviceId ? 'Select a device first' : 'No registers available for this device'}
            </div>
          ) : (
            <div className="device-register-checklist__list">
              {registers.map(dr => (
                <label key={dr.id} className="device-register-checklist__item">
                  <input
                    type="checkbox"
                    checked={dr.register?.field_name ? value.includes(dr.register.field_name) : false}
                    onChange={() => dr.register?.field_name && handleToggle(dr.register_id, dr.register.field_name)}
                    disabled={false}
                    className="device-register-checklist__input"
                  />
                  <span className="device-register-checklist__item-label">
                    <span className="device-register-checklist__register-name">
                      {dr.register?.name || 'Unknown'}
                    </span>
                    {dr.register?.unit && (
                      <span className="device-register-checklist__register-unit">
                        ({dr.register.unit})
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DeviceRegisterChecklist;
