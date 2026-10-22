/**
 * In-browser edit for a tabular document (xlsx/xls/csv) opened from
 * DocumentsGrid, instead of the plain "sign a URL and open a new tab" path
 * that just downloads the file for these types (browsers can't render them).
 *
 * Opens a real new browser tab (not a dialog) and renders into THAT tab's
 * own document — via a second React root targeting a node in its DOM, same
 * createRoot pattern utils/confirmationHelper.tsx uses for an in-page modal,
 * just pointed at a second window instead of a container div in this one.
 * Works because this call happens synchronously in the opener's JS realm;
 * React only needs the container's ownerDocument to create nodes in it, and
 * the new tab is same-origin so DOM/stylesheet access across the two is
 * unrestricted. No per-app route needed for this to work in both TBWC and
 * MeterItPro — it's a plain function call, not a navigation.
 *
 * Avoid MUI components that render through a Portal (Dialog, Menu, Tooltip,
 * Popover, Snackbar) anywhere in this tree — those portal to the GLOBAL
 * `document`, which would land them in the opener tab, not this one. The
 * discard-confirm uses the new tab's own native `confirm()` instead, for the
 * same reason.
 *
 * The grid itself is jspreadsheet-ce (column letters, row numbers, toolbar,
 * resize/sort, basic in-cell formulas while editing) — a real Excel-like
 * surface, not a key/value table. No round-trip fidelity for formulas or
 * cell formatting though: save reads back whatever's currently displayed in
 * each cell and writes it as a plain value.
 *
 * Save replaces the row in place: upload the edited bytes under a new
 * storage path, create the new metadata row (same description/doc_type),
 * then remove the old row/object — metadata first, so a mid-failure never
 * leaves the grid pointing at a deleted object.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import jspreadsheet from 'jspreadsheet-ce';
import 'jsuites/dist/jsuites.css';
import 'jspreadsheet-ce/dist/jspreadsheet.css';
import { AppBar, Alert, Box, Button, CircularProgress, Toolbar, Typography } from '@mui/material';
import { storagePathFor, type DocumentRecord, type DocumentStorage, type DocumentsApi } from './types';

type CellValue = string | number | boolean;

const BOOK_TYPE: Record<string, XLSX.BookType> = { xlsx: 'xlsx', xls: 'xls', csv: 'csv' };
const MIME_FOR_EXT: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
};
// Extra blank rows/cols past the data so it reads as a sheet, not a cropped table.
const MIN_ROWS = 40;
const MIN_COLS = 18;

function extOf(fileName: string): string {
  return (fileName.split('.').pop() || 'xlsx').toLowerCase();
}

/** Extensions this editor can actually parse/round-trip. */
export function isEditableTabularFile(fileName: string): boolean {
  return ['xlsx', 'xls', 'csv'].includes(extOf(fileName));
}

/** Sheet -> rectangular array of arrays, every row padded to the widest row. */
function sheetToAoa(sheet: XLSX.WorkSheet): CellValue[][] {
  const rows = XLSX.utils.sheet_to_json<CellValue[]>(sheet, { header: 1, defval: '', blankrows: false });
  const width = rows.reduce((max, row) => Math.max(max, row.length), 1);
  return rows.map((row) => {
    const padded = row.slice();
    while (padded.length < width) padded.push('');
    return padded;
  });
}

/** Copy every stylesheet (MUI + jspreadsheet/jsuites CSS included — anything
 *  already loaded in this tab) into the new tab's head, with hrefs resolved
 *  to absolute URLs first since the new tab's base URL isn't this page's. */
function copyStylesInto(targetDoc: Document): void {
  document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    const clone = targetDoc.createElement('link');
    clone.rel = 'stylesheet';
    clone.href = (link as HTMLLinkElement).href;
    targetDoc.head.appendChild(clone);
  });
  document.querySelectorAll('style').forEach((style) => {
    targetDoc.head.appendChild(style.cloneNode(true));
  });
}

export interface OpenXlsxEditorOptions {
  doc: DocumentRecord;
  entityType: string;
  recordId: string;
  api: DocumentsApi;
  storage: DocumentStorage;
  /** Called once the edited file has been saved back, so the caller can reload its grid. */
  onSaved: () => void;
}

/** Imperative entry point — DocumentsGrid calls this instead of rendering a dialog. */
export function openXlsxEditorWindow(opts: OpenXlsxEditorOptions): void {
  const win = window.open('', '_blank');
  if (!win) {
    window.alert("Couldn't open a new tab — your browser may have blocked the popup.");
    return;
  }
  win.document.title = opts.doc.file_name;
  win.document.body.style.margin = '0';
  copyStylesInto(win.document);
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);

  const root = createRoot(container);
  const close = () => {
    root.unmount();
    win.close();
  };
  root.render(
    <XlsxEditorPage
      win={win}
      doc={opts.doc}
      entityType={opts.entityType}
      recordId={opts.recordId}
      api={opts.api}
      storage={opts.storage}
      onSaved={opts.onSaved}
      onClose={close}
    />
  );
}

interface XlsxEditorPageProps {
  win: Window;
  doc: DocumentRecord;
  entityType: string;
  recordId: string;
  api: DocumentsApi;
  storage: DocumentStorage;
  onSaved: () => void;
  onClose: () => void;
}

const XlsxEditorPage: React.FC<XlsxEditorPageProps> = ({ win, doc, entityType, recordId, api, storage, onSaved, onClose }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<jspreadsheet.WorksheetInstance | null>(null);
  const dirtyRef = useRef(false);
  const [aoa, setAoa] = useState<CellValue[][] | null>(null);
  const [sheetName, setSheetName] = useState('Sheet1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the workbook into a plain array-of-arrays on mount.
  useEffect(() => {
    void (async () => {
      try {
        const url = await storage.viewUrl(doc.storage_path!);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Could not download file (${res.status})`);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const name = wb.SheetNames[0] || 'Sheet1';
        const sheet = wb.Sheets[name];
        setSheetName(name);
        setAoa(sheet ? sheetToAoa(sheet) : [['']]);
      } catch (e: any) {
        setError(e?.message || 'Could not open the file for editing.');
      } finally {
        setLoading(false);
      }
    })();
    // doc is fixed for the lifetime of this tab — one load, no re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount the jspreadsheet grid once the data's in; tear down on unmount.
  useEffect(() => {
    if (!aoa || !containerRef.current) return;
    const el = containerRef.current;
    const cols = Math.max(aoa[0]?.length ?? 1, MIN_COLS);
    const [worksheet] = jspreadsheet(el, {
      toolbar: true,
      // Any edit at all (cell, row, column) just needs to flip one flag —
      // onafterchanges covers every case instead of wiring each separately.
      onafterchanges: () => { dirtyRef.current = true; },
      worksheets: [
        {
          data: aoa,
          minDimensions: [cols, Math.max(aoa.length, MIN_ROWS)],
          columns: Array.from({ length: cols }, () => ({ type: 'text' })),
        },
      ],
    });
    instanceRef.current = worksheet;
    return () => {
      jspreadsheet.destroy(el as jspreadsheet.JspreadsheetInstanceElement);
      instanceRef.current = null;
    };
  }, [aoa]);

  // Native browser warning if the tab (or whole window) is closed directly
  // with unsaved edits — our own Cancel button handles the in-app case below.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      (e as any).returnValue = true;
    };
    win.addEventListener('beforeunload', handler);
    return () => win.removeEventListener('beforeunload', handler);
  }, [win]);

  const requestClose = () => {
    if (dirtyRef.current && !win.confirm('Discard unsaved changes?')) return;
    onClose();
  };

  const onSave = async () => {
    if (!instanceRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const data = instanceRef.current.getData() as CellValue[][];
      const ext = extOf(doc.file_name);
      const sheet = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, sheetName);
      const out = XLSX.write(wb, { bookType: BOOK_TYPE[ext] || 'xlsx', type: 'array' });
      const blob = new Blob([out], { type: MIME_FOR_EXT[ext] || 'application/octet-stream' });
      const newFile = new File([blob], doc.file_name, { type: blob.type });

      const path = storagePathFor(entityType, recordId, doc.file_name);
      await storage.upload(path, newFile);
      try {
        await api.create({
          entityType,
          entityId: recordId,
          fileName: doc.file_name,
          storageBucket: storage.bucket,
          storagePath: path,
          description: doc.description,
          docType: doc.doc_type,
          mimeType: newFile.type,
          fileSize: newFile.size,
        });
      } catch (metaError) {
        await storage.remove(path).catch(() => undefined);
        throw metaError;
      }

      // New row is in; drop the edited-from one (the API removes its bytes too).
      await api.remove(doc.document_id);

      dirtyRef.current = false;
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar sx={{ gap: 1 }}>
          <Typography variant="subtitle1" noWrap sx={{ flex: 1 }}>
            {doc.file_name}
          </Typography>
          <Button onClick={requestClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void onSave()} variant="contained" disabled={!aoa || loading || saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </Toolbar>
      </AppBar>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 3 }}>
            <CircularProgress size={20} />
            <Typography variant="body2">Loading...</Typography>
          </Box>
        )}
        <div ref={containerRef} style={{ display: loading || !aoa ? 'none' : 'block' }} />
      </Box>
    </Box>
  );
};
