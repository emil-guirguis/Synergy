/**
 * Device Form - READ-ONLY
 * 
 * Uses the dynamic schema-based BaseForm to render the device form in read-only mode.
 * All fields are read-only as devices are managed externally.
 * No create/update/delete operations are available.
 */

import React from 'react';
import { BaseForm } from '@meterit/framework-frontend/components/form/BaseForm';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import { useDevicesEnhanced } from './devicesStore';
import { RegistersGrid } from './RegistersGrid';
import type { Device } from './deviceConfig';
import './DeviceForm.css';

interface DeviceFormProps {
  device?: Device;
  onCancel: () => void;
  loading?: boolean;
}

export const DeviceForm: React.FC<DeviceFormProps> = ({
  device,
  onCancel,
  loading = false,
}) => {
  const devices = useDevicesEnhanced();

  // Use schema from cache (prefetched at login) - not used directly but needed for BaseForm
  useSchema('device');

  // Read-only handler - no actual submission
  const handleReadOnlySubmit = async () => {
    // No-op: devices are read-only
  };

  // Custom field renderer for registers
  const renderCustomField = (
    fieldName: string,
    _fieldDef: any,
    _value: any,
    _error: string | undefined,
    _isDisabled: boolean,
    _onChange: (value: any) => void
  ) => {
    
    if (fieldName === 'registers') {
      if (!device) {
        return <div>No device selected</div>;
      }
      
      // Get device ID - use 'device_id' field from device object
      const deviceId = device.device_id;
      if (!deviceId && deviceId !== 0) {
        return <div>Device ID not available. Available keys: {Object.keys(device).join(', ')}</div>;
      }
      
      return (
        <RegistersGrid
          deviceId={Number(deviceId)}
          onError={(error) => console.error('RegistersGrid error:', error)}
        />
      );
    }
    return null; // Let BaseForm handle other fields normally
  };

  return (
    <BaseForm
      schemaName="device"
      entity={device}
      store={devices}
      onCancel={onCancel}
      onSubmit={handleReadOnlySubmit}
      className="device-form device-form--readonly"
      loading={loading}
      showTabs={true}
      onTabChange={undefined}
      renderCustomField={renderCustomField}
    />
  );
};

export default DeviceForm;
