/**
 * Per-record documents grid — the shared UI half of the documents module.
 *
 * Drops into any module's form as a custom field (see TBWC's OrderForm /
 * InvoiceForm / InventoryForm) and attaches files to that record by
 * (entityType, entityId). Rows are their own resource, saved the moment they
 * change — nothing here rides on the parent form's Save button.
 *
 * Flow for a new document: "+ Add" appends a draft row (description + type
 * editable) whose file cell is an upload icon. Picking a file uploads the bytes
 * straight to the storage bucket, then POSTs the metadata row; a failed metadata
 * write removes the just-uploaded object so the bucket doesn't collect orphans.
 *
 * Storage-agnostic by construction: it only knows the DocumentsApi (metadata)
 * and DocumentStorage (bytes) interfaces, so swapping Supabase Storage for R2 or
 * DB blobs is a new DocumentStorage implementation, not a change here.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CloseIcon from '@mui/icons-material/Close';
import {
  DEFAULT_DOC_TYPE,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  formatFileSize,
  storagePathFor,
  type DocType,
  type DocumentRecord,
  type DocumentStorage,
  type DocumentsApi,
} from './types';

export interface DocumentsGridProps {
  /** Module key stored on the row, e.g. "order" | "invoice" | "inventory". */
  entityType: string;
  /** PK of the owning record. Undefined (unsaved parent) disables the grid. */
  entityId?: string | number | null;
  api: DocumentsApi;
  storage: DocumentStorage;
  /** Hide every mutating control (upload / edit / delete). */
  readOnly?: boolean;
  /** Client-side guard; the API enforces its own limit too. Default 25MB. */
  maxFileSize?: number;
  emptyMessage?: string;
}

interface DraftRow {
  key: string;
  description: string;
  docType: DocType;
}

const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
// Matches description varchar(2000) in framework/backend/db/document.sql —
// cap it in the input rather than let the API bounce a too-long save.
const MAX_DESCRIPTION = 2000;

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

function newDraft(): DraftRow {
  const key =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { key, description: '', docType: DEFAULT_DOC_TYPE };
}

export const DocumentsGrid: React.FC<DocumentsGridProps> = ({
  entityType,
  entityId,
  api,
  storage,
  readOnly = false,
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  emptyMessage = 'No documents',
}) => {
  const [rows, setRows] = useState<DocumentRecord[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  // One hidden input reused by every row; the draft it belongs to is stashed
  // here at click time so the change handler knows which row to complete.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingDraftRef = useRef<DraftRow | null>(null);

  const recordId = entityId != null && entityId !== '' ? String(entityId) : null;
  const disabled = readOnly || !recordId;

  const load = useCallback(async () => {
    if (!recordId) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      setRows(await api.list(entityType, recordId));
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [api, entityType, recordId]);

  useEffect(() => {
    void load();
    setDrafts([]);
  }, [load]);

  const patchDraft = (key: string, patch: Partial<DraftRow>) =>
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const pickFile = (draft: DraftRow) => {
    pendingDraftRef.current = draft;
    fileInputRef.current?.click();
  };

  /** Upload bytes, then write the metadata row; roll the object back if that fails. */
  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the same file twice still fires a change event.
    e.target.value = '';
    const draft = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (!file || !draft || !recordId) return;

    if (file.size > maxFileSize) {
      setError(`"${file.name}" is ${formatFileSize(file.size)} — the limit is ${formatFileSize(maxFileSize)}.`);
      return;
    }

    const path = storagePathFor(entityType, recordId, file.name);
    setBusyKey(draft.key);
    setError(null);
    try {
      await storage.upload(path, file);
      try {
        await api.create({
          entityType,
          entityId: recordId,
          fileName: file.name,
          storageBucket: storage.bucket,
          storagePath: path,
          description: draft.description || null,
          docType: draft.docType,
          mimeType: file.type || null,
          fileSize: file.size,
        });
      } catch (metaError) {
        await storage.remove(path).catch(() => undefined);
        throw metaError;
      }
      setDrafts((ds) => ds.filter((d) => d.key !== draft.key));
      await load();
    } catch (err: any) {
      setError(err?.message || 'Upload failed');
    } finally {
      setBusyKey(null);
    }
  };

  const saveRow = async (row: DocumentRecord, patch: { description?: string; docType?: DocType }) => {
    setBusyKey(String(row.document_id));
    try {
      const updated = await api.update(row.document_id, patch);
      setRows((rs) => rs.map((r) => (r.document_id === row.document_id ? updated : r)));
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to save document');
      await load(); // put the visible value back in sync with the DB
    } finally {
      setBusyKey(null);
    }
  };

  const openFile = async (row: DocumentRecord) => {
    if (!row.storage_path) return;
    // Open the tab synchronously on the click, then point it at the signed URL —
    // opening after the await would be a popup-blocked no-op.
    const win = window.open('', '_blank');
    try {
      const url = await storage.viewUrl(row.storage_path);
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (e: any) {
      win?.close();
      setError(e?.message || 'Could not open the file');
    }
  };

  const confirmDelete = async () => {
    if (!confirmRow) return;
    setDeleting(true);
    try {
      await api.remove(confirmRow.document_id);
      // Metadata first, object second: an orphaned object is sweepable, an
      // orphaned row is a broken link in the grid.
      if (confirmRow.storage_path) await storage.remove(confirmRow.storage_path).catch(() => undefined);
      setConfirmRow(null);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to delete document');
    } finally {
      setDeleting(false);
    }
  };

  const typeOptions = useMemo(
    () => DOC_TYPES.map((t) => <MenuItem key={t} value={t}>{DOC_TYPE_LABELS[t]}</MenuItem>),
    []
  );

  const colCount = readOnly ? 5 : 6;

  return (
    <Box>
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {!recordId && !readOnly && (
        <Alert severity="info" sx={{ mb: 1 }}>
          Save this record before attaching documents.
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '38%' }}>Description</TableCell>
              <TableCell sx={{ width: '14%' }}>Type</TableCell>
              <TableCell sx={{ width: '28%' }}>File</TableCell>
              <TableCell sx={{ width: '10%' }}>Size</TableCell>
              <TableCell sx={{ width: '10%' }}>Uploaded</TableCell>
              {!readOnly && (
                <TableCell align="right" sx={{ width: '60px' }}>
                  <Button size="small" onClick={() => setDrafts((ds) => [...ds, newDraft()])} disabled={disabled}>
                    + Add
                  </Button>
                </TableCell>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={colCount} align="center">
                  <CircularProgress size={20} />
                </TableCell>
              </TableRow>
            )}

            {!loading && rows.length === 0 && drafts.length === 0 && (
              <TableRow>
                <TableCell colSpan={colCount} align="center">
                  <Typography variant="body2" color="text.secondary">{emptyMessage}</Typography>
                </TableCell>
              </TableRow>
            )}

            {rows.map((row) => {
              const busy = busyKey === String(row.document_id);
              return (
                <TableRow key={row.document_id} hover>
                  <TableCell>
                    <TextField
                      defaultValue={row.description ?? ''}
                      placeholder="Description"
                      size="small"
                      fullWidth
                      variant="standard"
                      disabled={readOnly || busy}
                      inputProps={{ maxLength: MAX_DESCRIPTION }}
                      onBlur={(e) => {
                        const next = e.target.value;
                        if (next !== (row.description ?? '')) void saveRow(row, { description: next });
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={row.doc_type}
                      size="small"
                      fullWidth
                      variant="standard"
                      disabled={readOnly || busy}
                      onChange={(e) => void saveRow(row, { docType: e.target.value as DocType })}
                    >
                      {typeOptions}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Tooltip title="Open file">
                        <span>
                          <IconButton size="small" onClick={() => void openFile(row)} disabled={!row.storage_path}>
                            <OpenInNewIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Typography
                        variant="body2"
                        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={row.file_name}
                      >
                        {row.file_name}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">{formatFileSize(row.file_size)}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">{formatDate(row.created_at)}</Typography>
                  </TableCell>
                  {!readOnly && (
                    <TableCell align="right">
                      {busy ? (
                        <CircularProgress size={16} />
                      ) : (
                        <Tooltip title="Delete document">
                          <IconButton size="small" onClick={() => setConfirmRow(row)}>
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}

            {!readOnly &&
              drafts.map((draft) => {
                const busy = busyKey === draft.key;
                return (
                  <TableRow key={draft.key} selected>
                    <TableCell>
                      <TextField
                        value={draft.description}
                        placeholder="Description"
                        size="small"
                        fullWidth
                        variant="standard"
                        autoFocus
                        disabled={busy}
                        inputProps={{ maxLength: MAX_DESCRIPTION }}
                        onChange={(e) => patchDraft(draft.key, { description: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={draft.docType}
                        size="small"
                        fullWidth
                        variant="standard"
                        disabled={busy}
                        onChange={(e) => patchDraft(draft.key, { docType: e.target.value as DocType })}
                      >
                        {typeOptions}
                      </Select>
                    </TableCell>
                    <TableCell colSpan={3}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Tooltip title="Choose a file to upload">
                          <span>
                            <IconButton size="small" onClick={() => pickFile(draft)} disabled={busy || disabled}>
                              <UploadFileIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Typography variant="body2" color="text.secondary">
                          {busy ? 'Uploading…' : 'Select a file'}
                        </Typography>
                        {busy && <CircularProgress size={14} />}
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Discard row">
                        <span>
                          <IconButton
                            size="small"
                            disabled={busy}
                            onClick={() => setDrafts((ds) => ds.filter((d) => d.key !== draft.key))}
                          >
                            <CloseIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </TableContainer>

      <input ref={fileInputRef} type="file" hidden onChange={handleFileChosen} />

      <Dialog open={!!confirmRow} onClose={() => (deleting ? undefined : setConfirmRow(null))}>
        <DialogTitle>Delete document</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete "{confirmRow?.file_name}"? The file is removed from storage and cannot be recovered.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRow(null)} disabled={deleting}>Cancel</Button>
          <Button onClick={() => void confirmDelete()} color="error" disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default DocumentsGrid;
