import React, { useState, useRef } from 'react';
import './JsonGridEditor.css';

export interface GridColumn {
  key: string;
  label: string;
}

export interface JsonGridEditorProps {
  data: Record<string, any>[];
  onChange: (updatedData: Record<string, any>[]) => void;
  onRowAdd?: () => void;
  onRowDelete?: (rowIndex: number) => void;
  readOnly?: boolean;
  onImport?: (importedData: Record<string, any>[]) => void;
  fileInputRef?: React.RefObject<HTMLInputElement | null>;
}

interface EditingCell {
  rowIndex: number;
  columnKey: string;
}

const formatColumnLabel = (key: string): string => {
  return key
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const detectColumns = (data: Record<string, any>[]): GridColumn[] => {
  if (!data || data.length === 0) return [];
  
  const keys = new Set<string>();
  data.forEach(row => {
    Object.keys(row).forEach(key => keys.add(key));
  });

  // Insertion order (first-seen, left-to-right) rather than alphabetical —
  // a spreadsheet's column order is meaningful and shouldn't get reshuffled.
  return Array.from(keys)
    .map(key => ({
      key,
      label: formatColumnLabel(key)
    }));
};

const createEmptyRow = (columns: GridColumn[]): Record<string, any> => {
  const row: Record<string, any> = {};
  columns.forEach(col => {
    row[col.key] = '';
  });
  return row;
};

export const JsonGridEditor: React.FC<JsonGridEditorProps> = ({
  data,
  onChange,
  onRowAdd,
  onRowDelete,
  readOnly = false,
  onImport,
  fileInputRef: externalFileInputRef
}) => {
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const internalFileInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = externalFileInputRef || internalFileInputRef;

  const columns = detectColumns(data);

  const handleCellClick = (rowIndex: number, columnKey: string) => {
    if (readOnly) return;
    const value = data[rowIndex]?.[columnKey] ?? '';
    setEditingCell({ rowIndex, columnKey });
    setEditValue(String(value));
  };

  const handleCellChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  };

  const handleCellBlur = () => {
    if (editingCell) {
      const newData = [...data];
      newData[editingCell.rowIndex] = {
        ...newData[editingCell.rowIndex],
        [editingCell.columnKey]: editValue
      };
      onChange(newData);
    }
    setEditingCell(null);
    setEditValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleCellBlur();
    } else if (e.key === 'Escape') {
      setEditingCell(null);
      setEditValue('');
    }
  };

  const handleAddRow = () => {
    const newRow = createEmptyRow(columns);
    const newData = [...data, newRow];
    onChange(newData);
    onRowAdd?.();
  };

  const handleDeleteRow = (rowIndex: number) => {
    const newData = data.filter((_, idx) => idx !== rowIndex);
    onChange(newData);
    onRowDelete?.(rowIndex);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const lines = content.split('\n').filter(line => line.trim());
        
        if (lines.length === 0) return;

        const headers = lines[0].split(',').map(h => h.trim());
        const importedData: Record<string, any>[] = [];

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map(v => v.trim());
          const row: Record<string, any> = {};
          headers.forEach((header, idx) => {
            row[header] = values[idx] || '';
          });
          importedData.push(row);
        }

        onChange(importedData);
        onImport?.(importedData);
      } catch (error) {
        console.error('Error importing file:', error);
      }
    };
    reader.readAsText(file);
  };

  if (columns.length === 0 && data.length === 0) {
    return (
      <div className="json-grid-editor empty">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={handleImport}
          className="hidden-file-input"
          aria-label="Import CSV file"
          title="Import CSV file"
        />
        <div className="empty-state">
          <p>No data yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="json-grid-editor">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xlsx,.xls"
        onChange={handleImport}
        className="hidden-file-input"
        aria-label="Import CSV file"
        title="Import CSV file"
      />
      <div className="grid-toolbar">
        {!readOnly && (
          <button type="button" className="btn-add-row" onClick={handleAddRow}>
            + Add Row
          </button>
        )}
      </div>

      <div className="grid-container">
        <table className="grid-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col.key}>{col.label}</th>
              ))}
              {!readOnly && <th className="col-actions">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {data.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map(col => (
                  <td
                    key={`${rowIndex}-${col.key}`}
                    className={editingCell?.rowIndex === rowIndex && editingCell?.columnKey === col.key ? 'editing' : ''}
                    onClick={() => handleCellClick(rowIndex, col.key)}
                  >
                    {editingCell?.rowIndex === rowIndex && editingCell?.columnKey === col.key ? (
                      <input
                        ref={inputRef}
                        type="text"
                        value={editValue}
                        onChange={handleCellChange}
                        onBlur={handleCellBlur}
                        onKeyDown={handleKeyDown}
                        autoFocus
                        title={`Edit ${col.label}`}
                      />
                    ) : (
                      <span>{row[col.key] ?? ''}</span>
                    )}
                  </td>
                ))}
                {!readOnly && (
                  <td className="col-actions">
                    <button
                      type="button"
                      className="btn-delete"
                      onClick={() => handleDeleteRow(rowIndex)}
                      title="Delete row"
                    >
                      🗑️
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default JsonGridEditor;
