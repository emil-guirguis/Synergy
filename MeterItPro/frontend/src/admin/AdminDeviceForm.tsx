import React from 'react';
import { BaseForm } from '@meterit/framework-frontend/components/form/BaseForm';
import { useAdminDevicesEnhanced, type AdminDevice } from './adminDevicesStore';
import { RegistersGrid } from '../features/devices/RegistersGrid';

interface AdminDeviceFormProps {
  device?: AdminDevice;
  onCancel: () => void;
  onSubmit?: (data: any) => Promise<void>;
}

export const AdminDeviceForm: React.FC<AdminDeviceFormProps> = ({ device, onCancel, onSubmit }) => {
  const store = useAdminDevicesEnhanced();

  const renderCustomField = (
    fieldName: string,
    _fieldDef: any,
    _value: any,
    _error: string | undefined,
    _isDisabled: boolean,
    _onChange: (value: any) => void,
  ) => {
    if (fieldName === 'registers' && device?.device_id) {
      return (
        <RegistersGrid
          deviceId={Number(device.device_id)}
          onError={(err) => console.error('RegistersGrid error:', err)}
        />
      );
    }
    return null;
  };

  return (
    <BaseForm
      schemaName="device"
      entity={device}
      store={store}
      onCancel={onCancel}
      onSubmit={onSubmit}
      className="admin-device-form"
      showTabs={true}
      renderCustomField={renderCustomField}
    />
  );
};
