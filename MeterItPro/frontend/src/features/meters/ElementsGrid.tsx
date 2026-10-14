import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { EditableDataGrid, type GridColumn, useGridToast, useUnsavedRow } from '@meterit/framework-frontend/components/datagrid/';
import apiClient from '../../services/apiClient';
import './ElementsGrid.css';

export interface MeterElement {
  meter_element_id: number;
  meter_id: number;
  name: string;
  element: string;
  created_at?: string;
  updated_at?: string;
}

interface SchemaField {
  type: string;
  label: string;
  readOnly?: boolean;
  required?: boolean;
  enumValues?: string[];
}

interface ElementsGridProps {
  meterId: number;
  onError?: (error: Error) => void;
  onSuccess?: (message: string) => void;
}

const extractErrorMessage = (err: any, defaultMessage: string): string => {
  const errorResponse = err?.response?.data;
  if (errorResponse?.errors) {
    return Object.entries(errorResponse.errors).map(([, message]) => `${message}`).join(', ');
  }
  if (errorResponse?.message) return errorResponse.message;
  if (err instanceof Error) return err.message;
  return defaultMessage;
};

export const ElementsGrid: React.FC<ElementsGridProps> = ({ meterId, onError, onSuccess }) => {
  const [elements, setElements] = useState<MeterElement[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [schema, setSchema]     = useState<Record<string, SchemaField> | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Record<string, { rowId: number; column: string; value: string }>>({});

  const { toastProps, showSuccess, showError } = useGridToast();

  const {
    unsavedRow,
    unsavedRef,
    itemsRef: elementsRef,
    hasUnsaved,
    handleAddRow: handleAddElement,
    handleRowDelete: handleUnsavedRowDelete,
    updateUnsavedField,
    clearUnsaved,
    getActualRowId,
  } = useUnsavedRow(elements, { name: '', element: '' });

  console.log('🔄 [ElementsGrid] Refs updated:', {
    elementsCount: elements.length,
    elements: elements.map(e => e.element),
    unsavedElement: unsavedRow?.element,
  });

  const columns: GridColumn[] = useMemo(() => {
    if (!schema) return [];

    const allElementOptions = schema.element?.enumValues || [];

    const getAvailableOptions = (_rowId: number): string[] => {
      const usedLetters = new Set<string>(elementsRef.current.map(el => el.element.trim().toUpperCase()));
      if (unsavedRef.current?.element) usedLetters.add(unsavedRef.current.element.trim().toUpperCase());
      const available = allElementOptions.filter(opt => !usedLetters.has(opt.toUpperCase()));
      console.log('📊 [ElementsGrid] getAvailableOptions called:', {
        usedLetters: Array.from(usedLetters),
        available,
        elementsCount: elementsRef.current.length,
        elements: elementsRef.current.map(e => `"${e.element}"`),
        unsavedElement: `"${unsavedRef.current?.element}"`,
      });
      return available;
    };

    return [
      {
        key: 'element',
        label: schema.element?.label || 'Element',
        editable: !schema.element?.readOnly,
        type: allElementOptions.length > 0 ? 'select' : 'text',
        options: allElementOptions.length > 0 ? getAvailableOptions : undefined,
      },
      {
        key: 'name',
        label: schema.name?.label || 'Name',
        editable: !schema.name?.readOnly,
        type: 'text',
      },
    ];
  }, [schema, elements, unsavedRow]);

  const loadSchema = useCallback(async () => {
    try {
      const response = await apiClient.get(`/meters/${meterId}/elements/schema`);
      const schemaData = response.data.data;
      const formFields: Record<string, SchemaField> = {};
      if (schemaData.formFields) {
        Object.entries(schemaData.formFields).forEach(([key, fieldData]: [string, any]) => {
          formFields[key] = {
            type: fieldData.type,
            label: fieldData.label,
            readOnly: fieldData.readOnly,
            required: fieldData.required,
            enumValues: fieldData.enumValues,
          };
        });
      }
      setSchema(formFields);
    } catch {
      setSchema({
        name: { type: 'STRING', label: 'Name', readOnly: false, required: true },
        element: {
          type: 'STRING',
          label: 'Element',
          readOnly: false,
          required: true,
          enumValues: ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'],
        },
      });
    }
  }, [meterId]);

  const loadElements = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get(`/meters/${meterId}/elements`);
      setElements(response.data.data || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load elements';
      setError(errorMessage);
      onError?.(new Error(errorMessage));
    } finally {
      setLoading(false);
    }
  }, [meterId, onError]);

  useEffect(() => {
    loadSchema();
    loadElements();
  }, [meterId, loadSchema, loadElements]);

  const handleSaveUnsavedRow = useCallback(async () => {
    if (!unsavedRow) return;

    if (!unsavedRow.name?.trim() || !unsavedRow.element?.trim()) {
      const errorMsg = 'Name and Element are required';
      setError(errorMsg);
      showError(errorMsg);
      return;
    }

    try {
      const response = await apiClient.post(`/meters/${meterId}/elements`, {
        name: unsavedRow.name,
        element: unsavedRow.element,
      });
      setElements([response.data.data, ...elements]);
      clearUnsaved();
      setError(null);
      showSuccess('Element added successfully');
      onSuccess?.('Element added successfully');
    } catch (err) {
      const errorMessage = extractErrorMessage(err, 'Failed to add element');
      setError(errorMessage);
      showError(errorMessage);
      onError?.(new Error(errorMessage));
    }
  }, [meterId, unsavedRow, elements, clearUnsaved, showSuccess, showError, onError, onSuccess]);

  const handleSavePendingChange = useCallback(
    async (rowId: number, column: string, value: string) => {
      const actualRowId = getActualRowId(rowId);
      const element = elements[actualRowId];
      if (!element) return;

      try {
        await apiClient.put(`/meters/${meterId}/elements/${element.meter_element_id}`, { [column]: value });
        setError(null);
        showSuccess('Element updated successfully');
        onSuccess?.('Element updated successfully');
      } catch (err) {
        const originalValue = (element as any)[column];
        const reverted = [...elements];
        (reverted[actualRowId] as any)[column] = originalValue;
        setElements(reverted);
        const errorMessage = extractErrorMessage(err, 'Failed to update element');
        setError(errorMessage);
        showError(errorMessage);
        onError?.(new Error(errorMessage));
      }
    },
    [meterId, elements, getActualRowId, showSuccess, showError, onError, onSuccess],
  );

  const handleCellChange = useCallback(
    (rowId: number, column: string, value: string) => {
      if (hasUnsaved && rowId === 0) {
        updateUnsavedField(column, value);
        return;
      }

      const actualRowId = getActualRowId(rowId);
      const element = elements[actualRowId];
      if (!element) return;

      if (column === 'name' && !value?.trim()) { setError('Name is required'); return; }
      if (column === 'element' && !value?.trim()) { setError('Element is required'); return; }

      if (column === 'element' && value) {
        const trimmed = value.trim().toUpperCase();
        const isDuplicate = elements.some(el => el.meter_element_id !== element.meter_element_id && el.element.trim().toUpperCase() === trimmed);
        if (isDuplicate) {
          showError(`Element "${trimmed}" is already assigned to this meter`);
          return;
        }
      }

      setError(null);
      const updated = [...elements];
      (updated[actualRowId] as any)[column] = value;
      setElements(updated);

      setPendingChanges(prev => ({ ...prev, [`${rowId}-${column}`]: { rowId, column, value } }));
    },
    [elements, hasUnsaved, getActualRowId, updateUnsavedField, showError],
  );

  const handleDeleteElement = useCallback(async (rowId: number) => {
    const actualRowId = getActualRowId(rowId);
    const element = elements[actualRowId];
    if (!element) return;

    try {
      await apiClient.delete(`/meters/${meterId}/elements/${element.meter_element_id}`);
      setElements(elements.filter(e => e.meter_element_id !== element.meter_element_id));
      setError(null);
      showSuccess('Element deleted successfully');
      onSuccess?.('Element deleted successfully');
    } catch (err) {
      const errorMessage = extractErrorMessage(err, 'Failed to delete element');
      setError(errorMessage);
      showError(errorMessage);
      onError?.(new Error(errorMessage));
    }
  }, [meterId, elements, getActualRowId, showSuccess, showError, onError, onSuccess]);

  const gridData = useMemo(() => {
    const data: any[] = [];
    if (unsavedRow) {
      data.push({ id: 'unsaved', name: unsavedRow.name, element: unsavedRow.element, _isUnsaved: true });
    }
    elements.forEach(el => data.push({ meter_element_id: el.meter_element_id, name: el.name, element: el.element }));
    return data;
  }, [elements, unsavedRow]);

  return (
    <div className="elements-grid">
      <EditableDataGrid
        title="Elements"
        data={gridData}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={loadElements}
        onRowAdd={handleAddElement}
        onRowDelete={(rowId) => { handleUnsavedRowDelete(rowId); }}
        onRowSave={(rowId) => { if (rowId === 0 && unsavedRow) void handleSaveUnsavedRow(); }}
        onCellChange={handleCellChange}
        onCellValidate={(rowId, column, value) => {
          if (column !== 'element' || !value) return true;
          const trimmed = value.trim().toUpperCase();
          if (hasUnsaved && rowId === 0) {
            const isDuplicate = elements.some(el => el.element.trim().toUpperCase() === trimmed);
            if (isDuplicate) { showError(`Element "${trimmed}" is already assigned to this meter`); return false; }
          } else {
            const actualRowId = getActualRowId(rowId);
            const element = elements[actualRowId];
            if (element) {
              const isDuplicate = elements.some(el => el.meter_element_id !== element.meter_element_id && el.element.trim().toUpperCase() === trimmed);
              if (isDuplicate) { showError(`Element "${trimmed}" is already assigned to this meter`); return false; }
              if (unsavedRow?.element.trim().toUpperCase() === trimmed) { showError(`Element "${trimmed}" is already assigned to this meter`); return false; }
            }
          }
          return true;
        }}
        onCellBlur={(rowId, column, value) => {
          if (hasUnsaved && rowId === 0 && unsavedRow?.name && unsavedRow?.element) {
            void handleSaveUnsavedRow();
          } else if (!hasUnsaved || rowId > 0) {
            const changeKey = `${rowId}-${column}`;
            if (pendingChanges[changeKey]) {
              void handleSavePendingChange(rowId, column, value);
              setPendingChanges(prev => { const u = { ...prev }; delete u[changeKey]; return u; });
            }
          }
        }}
        emptyMessage="No elements associated with this meter"
        addButtonLabel="Add"
        showDeleteConfirmation
        onConfirmDelete={(rowId) => handleDeleteElement(rowId)}
        deleteConfirmTitle="Delete Element"
        deleteConfirmMessage="Are you sure you want to delete this element?"
        {...toastProps}
      />
    </div>
  );
};

export default ElementsGrid;
