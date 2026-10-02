import React, { useState, useCallback, useRef } from 'react';
import {
  Table,
  TableContainer,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TextField,
  Select,
  MenuItem,
  Button,
  IconButton,
  Alert,
  CircularProgress,
  Box,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
} from '@mui/material';
import { Delete as DeleteIcon, Save as SaveIcon, Close as CloseIcon } from '@mui/icons-material';
import './EditableDataGrid.css';

export interface GridColumn {
  key: string;
  label: string;
  editable?: boolean;
  type?: 'text' | 'number' | 'select';
  width?: string;
  options?: string[] | ((rowId: number) => string[]);
}

export interface EditableDataGridProps {
  data: Record<string, any>[];
  columns: GridColumn[];
  onRowAdd?: () => void;
  onRowDelete?: (rowId: number) => void;
  onRowSave?: (rowId: number) => void;
  onRowCancel?: (rowId: number) => void;
  onCellChange?: (rowId: number, column: string, value: any) => void;
  onCellBlur?: (rowId: number, column: string, value: any) => void;
  onCellValidate?: (rowId: number, column: string, value: any) => boolean; // Returns true if valid
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyMessage?: string;
  addButtonLabel?: string;
  
  // Delete confirmation support
  showDeleteConfirmation?: boolean;
  onConfirmDelete?: (rowId: number) => Promise<void>;
  deleteConfirmTitle?: string;
  deleteConfirmMessage?: string;
  
  // Toast notification support
  showToast?: boolean;
  toastMessage?: string;
  toastSeverity?: 'success' | 'error';
  onToastClose?: () => void;

  // Visibility controls
  hideAddButton?: boolean;
  hideDeleteColumn?: boolean;
}

interface EditingCell {
  rowId: number;
  column: string;
}

export const EditableDataGrid: React.FC<EditableDataGridProps> = ({
  data,
  columns,
  onRowAdd,
  onRowDelete,
  onRowSave,
  onRowCancel,
  onCellChange,
  onCellBlur,
  onCellValidate,
  loading = false,
  error = null,
  onRetry,
  emptyMessage = 'No data available',
  addButtonLabel = 'Add',
  showDeleteConfirmation = false,
  onConfirmDelete,
  deleteConfirmTitle = 'Delete Row',
  deleteConfirmMessage = 'Are you sure you want to delete this row?',
  showToast = false,
  toastMessage = '',
  toastSeverity = 'success',
  onToastClose,
  hideAddButton = false,
  hideDeleteColumn = false,
}) => {
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [selectOpen, setSelectOpen] = useState(false);
  const [deleteConfirmRowId, setDeleteConfirmRowId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Always-current ref so setTimeout callbacks don't capture stale closures
  const onRowSaveRef = useRef(onRowSave);
  onRowSaveRef.current = onRowSave;

  const handleCellClick = useCallback(
    (rowId: number, column: GridColumn) => {
      if (column.editable === false) return;
      if (column.type === 'select') {
        // A `select` column may compute no options for a given row — e.g. a
        // picker meant only for the in-progress unsaved row (see
        // TenantEquipmentGrid/ManagedUsersGrid, which return null/[] for every
        // other row "so the floating select never opens"). Entering edit mode
        // anyway used to crash the render below (.map on a null options list)
        // the first time someone clicked an already-saved row's select cell.
        const opts = typeof column.options === 'function' ? column.options(rowId) : column.options;
        if (!opts || opts.length === 0) return;
      }
      const cellValue = data[rowId]?.[column.key] ?? '';
      setEditingCell({ rowId, column: column.key });
      setEditValue(String(cellValue).trim());
      if (column.type === 'select') {
        setSelectOpen(true);
      }
    },
    [data]
  );

  const handleCellChange = useCallback((value: string) => {
    setEditValue(value);
  }, []);

  const handleCellSave = useCallback((valueOverride?: string) => {
    if (editingCell && onCellChange) {
      const finalValue = (valueOverride !== undefined ? valueOverride : editValue).trim();
      onCellChange(editingCell.rowId, editingCell.column, finalValue);
      onCellBlur?.(editingCell.rowId, editingCell.column, finalValue);
      setEditingCell(null);
      setEditValue('');
    }
  }, [editingCell, editValue, onCellChange, onCellBlur]);

  const handleCellCancel = useCallback(() => {
    setEditingCell(null);
    setEditValue('');
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteConfirmRowId !== null && onConfirmDelete) {
      setIsDeleting(true);
      try {
        await onConfirmDelete(deleteConfirmRowId);
      } finally {
        setIsDeleting(false);
        setDeleteConfirmRowId(null);
      }
    }
  }, [deleteConfirmRowId, onConfirmDelete]);

  const handleDeleteClick = useCallback((rowId: number) => {
    if (showDeleteConfirmation) {
      setDeleteConfirmRowId(rowId);
    } else {
      onRowDelete?.(rowId);
    }
  }, [showDeleteConfirmation, onRowDelete]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (!editingCell) return;
        e.preventDefault();
        const currentIdx = columns.findIndex(col => col.key === editingCell.column);
        const nextCol = columns.slice(currentIdx + 1).find(col => col.editable !== false);
        const rowId = editingCell.rowId;
        const isUnsaved = data[rowId]?._isUnsaved;

        if (nextCol) {
          handleCellSave();
          setTimeout(() => {
            const nextCell = document.querySelector(
              `[data-row-id="${rowId}"][data-column="${nextCol.key}"]`
            ) as HTMLElement;
            nextCell?.click();
          }, 30);
        } else {
          handleCellSave();
          if (isUnsaved) {
            setTimeout(() => onRowSaveRef.current?.(rowId), 50);
          }
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (editingCell && data[editingCell.rowId]?._isUnsaved) {
          onRowCancel?.(editingCell.rowId);
        }
        handleCellCancel();
      }
    },
    [handleCellSave, handleCellCancel, editingCell, columns, data, onRowSave, onRowCancel]
  );

  const isEditing = (rowId: number, column: string) =>
    editingCell?.rowId === rowId && editingCell?.column === column;

  return (
    <Box className="editable-data-grid">
      {/* Error State */}
      {error && (
        <Alert
          severity="error"
          onClose={onRetry ? () => onRetry() : undefined}
          className="editable-data-grid__error"
        >
          {error}
          {onRetry && (
            <Button
              size="small"
              onClick={onRetry}
              sx={{ ml: 2 }}
            >
              Retry
            </Button>
          )}
        </Alert>
      )}

      {/* Table */}
      <TableContainer component={Paper} className="editable-data-grid__table">
        <Table>
          <TableHead>
            <TableRow>
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  style={{ width: column.width }}
                  className="editable-data-grid__header-cell"
                >
                  {column.label}
                </TableCell>
              ))}
              {!hideDeleteColumn && (
                <TableCell
                  style={{ width: '60px' }}
                  className="editable-data-grid__header-cell editable-data-grid__actions-header-cell"
                >
                  {!hideAddButton && (
                    <>
                      <Button
                        variant="text"
                        color="primary"
                        onClick={() => {
                          onRowAdd?.();
                          const firstCol = columns.find(col => col.editable !== false);
                          if (firstCol) {
                            setTimeout(() => {
                              const cell = document.querySelector(
                                `[data-row-id="0"][data-column="${firstCol.key}"]`
                              ) as HTMLElement;
                              cell?.click();
                            }, 50);
                          }
                        }}
                        disabled={loading || !onRowAdd}
                        className="editable-data-grid__add-button"
                        size="small"
                      >
                        + Add
                      </Button>
                      {loading && (
                        <CircularProgress
                          size={16}
                          className="editable-data-grid__loading"
                        />
                      )}
                    </>
                  )}
                </TableCell>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={hideDeleteColumn ? columns.length : columns.length + 1}
                  align="center"
                  className="editable-data-grid__empty"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              data.map((row, rowIndex) => {
                // Generate stable key from row data
                const rowKey = row.id ? String(row.id) : `row-${rowIndex}-${JSON.stringify(row).substring(0, 20)}`;
                return (
                <TableRow
                  key={rowKey}
                  className={`editable-data-grid__row ${row._isUnsaved ? '_unsaved' : ''}`}
                >
                  {columns.map((column) => (
                    <TableCell
                      key={`${rowIndex}-${column.key}`}
                      onClick={() => handleCellClick(rowIndex, column)}
                      data-row-id={rowIndex}
                      data-column={column.key}
                      className={`editable-data-grid__cell ${
                        column.editable !== false ? 'editable-data-grid__cell--editable' : ''
                      } ${
                        isEditing(rowIndex, column.key) ? 'editable-data-grid__cell--editing' : ''
                      }`}
                    >
                      {isEditing(rowIndex, column.key) ? (
                        column.type === 'select' && column.options ? (
                          <Select
                            autoFocus
                            open={selectOpen}
                            onOpen={() => setSelectOpen(true)}
                            onClose={(e) => {
                              // If closed by Escape, stop propagation so parent Dialog doesn't close
                              if (e && (e as React.KeyboardEvent).key === 'Escape') {
                                (e as React.SyntheticEvent).stopPropagation();
                                if (editingCell && data[editingCell.rowId]?._isUnsaved) {
                                  onRowCancel?.(editingCell.rowId);
                                }
                              }
                              setSelectOpen(false);
                              setEditingCell(null);
                              setEditValue('');
                            }}
                            value={editValue}
                            onChange={(e) => {
                              const newValue = e.target.value as string;
                              if (onCellValidate && editingCell) {
                                const isValid = onCellValidate(editingCell.rowId, editingCell.column, newValue);
                                if (!isValid) {
                                  setTimeout(() => setSelectOpen(true), 0);
                                  return;
                                }
                              }
                              if (editingCell && onCellChange) {
                                onCellChange(editingCell.rowId, editingCell.column, newValue);
                                onCellBlur?.(editingCell.rowId, editingCell.column, newValue);
                              }
                              if (editingCell) {
                                const rowId = editingCell.rowId;
                                const isUnsaved = data[rowId]?._isUnsaved;
                                const currentIdx = columns.findIndex(col => col.key === editingCell.column);
                                const nextCol = columns.slice(currentIdx + 1).find(col => col.editable !== false);
                                if (nextCol) {
                                  setTimeout(() => {
                                    const nextCell = document.querySelector(
                                      `[data-row-id="${rowId}"][data-column="${nextCol.key}"]`
                                    ) as HTMLElement;
                                    nextCell?.click();
                                  }, 50);
                                } else if (isUnsaved) {
                                  setTimeout(() => onRowSaveRef.current?.(rowId), 50);
                                }
                              }
                              setSelectOpen(false);
                              setEditingCell(null);
                              setEditValue('');
                            }}
                            size="small"
                            variant="outlined"
                            fullWidth
                            displayEmpty
                            className="editable-data-grid__select-input"
                          >
                            <MenuItem value=""><em>Select...</em></MenuItem>
                            {(
                              (typeof column.options === 'function' ? column.options(rowIndex) : column.options) ?? []
                            ).map((opt: string) => (
                              <MenuItem key={opt} value={opt}>{opt}</MenuItem>
                            ))}
                          </Select>
                        ) : (
                          <TextField
                            autoFocus
                            value={editValue}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleCellChange(e.target.value)}
                            onFocus={(e) => e.target.select()}
                            onBlur={() => handleCellSave()}
                            onKeyDown={handleKeyDown}
                            size="small"
                            variant="outlined"
                            fullWidth
                            className="editable-data-grid__input"
                          />
                        )
                      ) : (
                        <div className="editable-data-grid__cell-content">
                          <span>{row[column.key]}</span>
                          {column.type === 'select' && <span className="editable-data-grid__cell-dropdown-icon">▼</span>}
                        </div>
                      )}
                    </TableCell>
                  ))}
                  {!hideDeleteColumn && (
                    <TableCell
                      align="center"
                      className="editable-data-grid__actions-cell"
                    >
                      {row._isUnsaved ? (
                        <>
                          {onRowCancel && (
                            <IconButton
                              size="small"
                              onClick={() => onRowCancel(rowIndex)}
                              className="editable-data-grid__cancel-button"
                              title="Cancel"
                            >
                              <CloseIcon fontSize="small" />
                            </IconButton>
                          )}
                          <IconButton
                            size="small"
                            onClick={() => onRowSave?.(rowIndex)}
                            className="editable-data-grid__save-button"
                            title="Save row"
                            color="success"
                          >
                            <SaveIcon fontSize="small" />
                          </IconButton>
                        </>
                      ) : (
                        <IconButton
                          size="small"
                          onClick={() => handleDeleteClick(rowIndex)}
                          className="editable-data-grid__delete-button"
                          title="Delete row"
                          disabled={!onRowDelete}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      )}
                    </TableCell>
                  )}
                </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirmation && (
        <Dialog
          open={deleteConfirmRowId !== null}
          onClose={() => setDeleteConfirmRowId(null)}
        >
          <DialogTitle>{deleteConfirmTitle}</DialogTitle>
          <DialogContent>{deleteConfirmMessage}</DialogContent>
          <DialogActions>
            <Button onClick={() => setDeleteConfirmRowId(null)}>Cancel</Button>
            <Button
              onClick={handleDeleteConfirm}
              variant="contained"
              color="error"
              disabled={isDeleting}
            >
              {isDeleting ? <CircularProgress size={24} /> : 'Delete'}
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {/* Toast Notification */}
      {showToast && (
        <Snackbar
          open={showToast}
          autoHideDuration={4000}
          onClose={onToastClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        >
          <Alert
            onClose={onToastClose}
            severity={toastSeverity}
            sx={{ width: '100%' }}
          >
            {toastMessage}
          </Alert>
        </Snackbar>
      )}
    </Box>
  );
};

export default EditableDataGrid;
