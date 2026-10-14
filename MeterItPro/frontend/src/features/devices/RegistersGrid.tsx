import React, { useState, useEffect, useCallback } from 'react';
import { EditableDataGrid, type GridColumn } from '@meterit/framework-frontend/components/datagrid/';
import apiClient from '../../services/apiClient';
import './RegistersGrid.css';

export interface Register {
  id: number;
  register: string;
  name: string;
  unit: string;
  field_name: string;
  description?: string;
}

export interface DeviceRegister {
  id: number;
  device_id: number;
  register_id: number;
  register?: Register;
}

interface RegistersGridProps {
  deviceId: number;
  onError?: (error: Error) => void;
  onSuccess?: (message: string) => void;
}

export const RegistersGrid: React.FC<RegistersGridProps> = ({
  deviceId,
  onError,
}) => {
  console.log('RegistersGrid rendered with deviceId:', deviceId);
  
  const [registers, setRegisters] = useState<DeviceRegister[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read-only columns - no editing allowed
  const columns: GridColumn[] = [
    { key: 'register', label: 'Register', editable: false, type: 'text' },
    { key: 'name', label: 'Name', editable: false, type: 'text' },
    { key: 'description', label: 'Description', editable: false, type: 'text' },
    { key: 'unit', label: 'Unit', editable: false, type: 'text' },
    { key: 'field_name', label: 'Field Name', editable: false, type: 'text' },
  ];

  const loadRegisters = useCallback(async () => {
    console.log('loadRegisters called for deviceId:', deviceId);
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get(`/devices/${deviceId}/registers`);
      console.log('RegistersGrid API response:', response);
      setRegisters(response.data.data || []);
    } catch (err) {
      console.error('RegistersGrid API error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to load registers';
      setError(errorMessage);
      onError?.(new Error(errorMessage));
    } finally {
      setLoading(false);
    }
  }, [deviceId, onError]);

  useEffect(() => {
    console.log('RegistersGrid useEffect triggered, deviceId:', deviceId);
    loadRegisters();
  }, [deviceId, loadRegisters]);

  const gridData = registers.map((dr) => ({
    id: dr.id, // Use id as the unique identifier
    device_id: dr.device_id,
    register: dr.register?.register || '',
    name: dr.register?.name || '',
    unit: dr.register?.unit || '',
    field_name: dr.register?.field_name || '',
    description: dr.register?.description || '',
  }));

  console.log('RegistersGrid render:', {
    deviceId,
    registersCount: registers.length,
    gridDataCount: gridData.length,
    loading,
    error,
    registers: registers.slice(0, 2) // Log first 2 for debugging
  });

  return (
    <div className="registers-grid registers-grid--readonly">
      <EditableDataGrid
        title="Registers"
        data={gridData}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={loadRegisters}
        emptyMessage="No registers associated with this device"
        hideAddButton={true}
        hideDeleteColumn={true}
      />
    </div>
  );
};

export default RegistersGrid;
