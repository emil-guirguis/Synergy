/**
 * Per-record documents grid — the shared UI half of the documents module.
 *
 * Drops into any module's form as a custom field (see TBWC's OrderForm /
 * InvoiceForm / InventoryForm) and attaches files to that record by
 * (entityType, entityId). Rows are their own resource, saved the moment they
 * change — nothing here rides on the parent form's Save button.
 *
 * Built on the framework ChildRowsGrid (one cell editable at a time, each row
 * saving itself): Description and Type edit in place, File/Size/Uploaded are
 * read-only. Columns come from the module's `<module>GridDocument` schema when
 * `schemaName` is given (framework documentGridSchema — also what gives each
 * module's documents their own Settings > Roles node and grants), else from
 * the identical built-in DEFAULT_DOCUMENT_SCHEMA below.
 *
 * Flow for a new document: "+ Add" opens a file picker straight away. The bytes
 * upload to the storage bucket, then the metadata row is POSTed (auto-typed via
 * classifyDocType); a failed metadata write removes the just-uploaded object so
 * the bucket doesn't collect orphans. Description/type are then edited in place.
 *
 * "Add Folder" is the bulk path: a webkitdirectory picker hands back every file
 * in the chosen folder (subfolders included) and, after a confirm, each one is
 * uploaded as its own row - the subfolder path becomes the description, and a
 * failure is collected and reported at the end instead of aborting the batch.
 *
 * The whole table is also a drop zone: dragging one or more files - or whole
 * folders - onto it goes through the same batch path as "Add Folder". A
 * dropped folder is recursed into via the DataTransferItem FileSystem API
 * (webkitGetAsEntry/createReader), same as picking one through the OS folder
 * browser, so every file at every depth gets its own row, subfolder path kept
 * as the description. Works for files dragged straight out of a desktop mail
 * client's attachment list too, which hands the browser a real File same as
 * a drag from the OS file explorer. Dragging an INLINE image out of an email
 * body is a different, unfixable case: the source (e.g. Gmail's inline-image
 * proxy) never gives the browser the original filename at all, so the File
 * that reaches onDrop is already misnamed (a random id) before any of our
 * code runs. The confirm dialog lets the name be fixed per file for exactly
 * that reason, on drop-sourced batches only - a real folder pick already has
 * correct names.
 *
 * Type is auto-set per file via the optional classifyDocType prop (a project
 * supplies its own rules - e.g. TBWC's shared/docTypeClassifier.ts - since
 * this module has to stay generic across projects); rows fall back to
 * DEFAULT_DOC_TYPE when no classifier is given.
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
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DriveFolderUploadIcon from '@mui/icons-material/DriveFolderUpload';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ShareIcon from '@mui/icons-material/Share';
import { ShareMenu } from './ShareMenu';
import { canShareFiles, shareDocumentFile } from './emailDocument';
import { EmailDocumentDialog } from './EmailDocumentDialog';
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
import { openXlsxEditorWindow, isEditableTabularFile } from './XlsxEditorWindow';
import { ChildRowsGrid, type ChildRowsApi } from '../components/datagrid/ChildRowsGrid';
import type { ConvertedSchema } from '../components/form/utils/schemaLoader';
import '../components/datagrid/EditableDataGrid.css';

export interface DocumentsGridProps {
  /** Module key stored on the row, e.g. "order" | "invoice" | "inventory". */
  entityType: string;
  /** PK of the owning record. Undefined (unsaved parent) disables the grid. */
  entityId?: string | number | null;
  api: DocumentsApi;
  storage: DocumentStorage;
  /** Hide every mutating control (upload / edit / delete). Superseded per action by
   *  canCreate / canEdit / canDelete when those are passed. */
  readOnly?: boolean;
  /** Per-action grants — e.g. orderGridDocument:create/write/delete. The API enforces them too. */
  canCreate?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  /** This module's documents grid schema (e.g. 'orderGridDocument', framework documentGridSchema).
   *  Omit to use the built-in column set. */
  schemaName?: string;
  /** Client-side guard; the API enforces its own limit too. Default 25MB. */
  maxFileSize?: number;
  /** Overrides the default oversize-file error text (still gated by maxFileSize). */
  oversizeMessage?: (file: File, maxFileSize: number) => string;
  emptyMessage?: string;
  /** Auto-set doc_type for dropped/folder files. Falls back to DEFAULT_DOC_TYPE when omitted. */
  classifyDocType?: (file: File) => DocType;
  /** Restrict both the visible rows and the Type dropdown to this subset — a
   *  project can show a cut-down set of types to a less-privileged viewer (e.g.
   *  TBWC hides the TBWC-only packing slip from reps). Omit to show/allow every
   *  DOC_TYPES value. A file that auto-classifies outside this set falls back
   *  to the first allowed type rather than being rejected client-side (the API
   *  is still the real enforcement boundary). */
  visibleDocTypes?: DocType[];
  /** Title bar above the grid (same chrome as EditableDataGrid's own `title`) — the schema
   *  section wrapping this field should be `bare: true` so BaseForm doesn't draw a second one. */
  title?: string;
}

const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
// Matches description varchar(2000) in framework/backend/db/document.sql —
// cap it in the input rather than let the API bounce a too-long save.
const MAX_DESCRIPTION = 2000;
// Parallel folder uploads: enough to hide per-file latency, low enough that a
// big folder doesn't open dozens of connections to the bucket at once.
const FOLDER_CONCURRENCY = 3;
// OS/editor droppings nobody means to attach; dotfiles are dropped as well.
const IGNORED_FILE_NAMES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);

/** Signed view URL turned into one that saves the file under its own name. */
function downloadUrlFor(signedUrl: string, fileName: string): string {
  return `${signedUrl}&download=${encodeURIComponent(fileName)}`;
}

/** The file's bytes, straight off its signed URL. */
async function fetchFileBlob(signedUrl: string): Promise<Blob> {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
  return res.blob();
}

// navigator.share() needs the click's user activation to still be live (~5s in
// Chrome), so fetching megabytes inside the click handler can lose the share
// sheet. The bytes are pulled while the share menu is open instead — but only
// when this browser can share files at all, and only for files small enough that
// the fetch isn't wasted on someone who just wanted "Copy link".
const SHARE_PREFETCH_MAX_BYTES = 15 * 1024 * 1024;

interface FolderJob {
  /** 'folder': picked via "Add Folder" (folderName is the picked folder's name).
   *  'drop': dragged onto the grid - may not share one folder, so the dialog
   *  skips the "from <folder>" framing and just lists the file(s). */
  source: 'folder' | 'drop';
  folderName: string;
  files: File[];
  /** Files left out before the batch started (too large), kept for the summary. */
  skipped: string[];
}

/** "Specs/2024" out of "Folder/Specs/2024/file.pdf" - becomes the row description. */
function relativeDirOf(file: File): string {
  return (file.webkitRelativePath || '').split('/').slice(1, -1).join('/');
}

function folderNameOf(file: File): string {
  return (file.webkitRelativePath || '').split('/')[0] || 'folder';
}

function readDirEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** readEntries() only returns entries in batches - keep calling until it returns empty. */
async function readAllDirEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await readDirEntries(reader);
    if (!batch.length) break;
    all.push(...batch);
  }
  return all;
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Recurse into a dropped file/directory entry, tagging each File's
 * webkitRelativePath (normally only set by an <input webkitdirectory> picker)
 * so a dropped folder is treated exactly like one picked via "Add Folder" -
 * same subfolder-as-description behavior, same leaf-folder classification.
 */
async function collectDroppedEntry(entry: FileSystemEntry, prefix: string, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    try {
      Object.defineProperty(file, 'webkitRelativePath', { value: `${prefix}${entry.name}`, configurable: true });
    } catch {
      // Can't shadow the getter in this engine - folder-context rules (description,
      // "shipping images" leaf-folder rule) just see no folder context for this file.
    }
    out.push(file);
  } else if (entry.isDirectory) {
    const children = await readAllDirEntries((entry as FileSystemDirectoryEntry).createReader());
    await Promise.all(children.map((child) => collectDroppedEntry(child, `${prefix}${entry.name}/`, out)));
  }
}

/**
 * Recurse a File System Access API directory handle the same way collectDroppedEntry
 * recurses a legacy FileSystemEntry - only reachable for a virtual folder drag, which
 * doesn't happen for a mail attachment, but kept for parity/completeness.
 */
async function collectFromDirectoryHandle(handle: any, prefix: string, out: File[]): Promise<void> {
  for await (const child of handle.values()) {
    if (child.kind === 'file') {
      const file: File = await child.getFile();
      try {
        Object.defineProperty(file, 'webkitRelativePath', { value: `${prefix}${child.name}`, configurable: true });
      } catch {
        // Can't shadow the getter in this engine - no folder context for this file.
      }
      out.push(file);
    } else if (child.kind === 'directory') {
      await collectFromDirectoryHandle(child, `${prefix}${child.name}/`, out);
    }
  }
}

/**
 * Resolve one item via getAsFileSystemHandle() - Chromium's async API for "virtual
 * files" (no real bytes on disk until requested): Outlook attachments, OneDrive/
 * SharePoint files-on-demand placeholders, and similar. This is the actual mechanism
 * apps like Dropbox and Gmail rely on to make those draggable into an upload target;
 * legacy webkitGetAsEntry()/getAsFile() both legitimately come back empty for them.
 * Must be invoked (not just feature-detected) synchronously off the drop event -
 * the Promise it returns is fine to await later, but the call itself has to happen
 * before the handler returns. Not implemented in every Chromium version, and never
 * in non-Chromium engines - callers still need the getAsFile() fallback below.
 */
function startFileSystemHandleLookup(item: DataTransferItem): Promise<any> | null {
  const getHandle = (item as any).getAsFileSystemHandle;
  return typeof getHandle === 'function' ? (getHandle.call(item) as Promise<any>) : null;
}

async function resolveFileSystemHandle(handlePromise: Promise<any>, out: File[]): Promise<boolean> {
  try {
    const handle = await handlePromise;
    if (!handle) return false;
    if (handle.kind === 'file') {
      out.push(await handle.getFile());
      return true;
    }
    if (handle.kind === 'directory') {
      await collectFromDirectoryHandle(handle, '', out);
      return true;
    }
  } catch {
    // Not a virtual file in this engine, or the handle came back empty - caller
    // falls back to getAsFile() next.
  }
  return false;
}

/**
 * Expand a drop's DataTransferItems into a flat File[], recursing into any dropped
 * folders. Tried in order per item, first that works wins:
 *   1. webkitGetAsEntry() - a real file/folder already on disk (Explorer, desktop
 *      Outlook's native OLE drag).
 *   2. getAsFileSystemHandle() - a "virtual file" with no bytes until fetched
 *      (Outlook web/free client's attachment drag, OneDrive placeholders).
 *   3. getAsFile() - last resort for a source that hands over a plain File without
 *      either of the above.
 * Falling back per item (rather than filtering the whole batch down to whichever
 * API happened to work) is what keeps one drop from silently vanishing.
 */
async function filesFromDroppedItems(items: DataTransferItem[]): Promise<File[]> {
  const out: File[] = [];
  const tasks: Promise<void>[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) {
      tasks.push(collectDroppedEntry(entry, '', out));
      continue;
    }
    const handlePromise = startFileSystemHandleLookup(item);
    // getAsFile() must also be called synchronously (same rule as above) - grab it
    // now even when a handle lookup is in flight, so there's still a fallback if
    // that lookup resolves to nothing, without a second (by-then-invalid) call.
    const syncFallbackFile = item.getAsFile();
    if (handlePromise) {
      tasks.push(
        resolveFileSystemHandle(handlePromise, out).then((resolved) => {
          if (!resolved && syncFallbackFile) out.push(syncFallbackFile);
        })
      );
    } else if (syncFallbackFile) {
      out.push(syncFallbackFile);
    }
  }
  await Promise.all(tasks);
  return out;
}

/**
 * Last-resort path for a drop that produced no File/entry at all - a web-based
 * mail client (Outlook on the web, as opposed to the desktop app's native OS
 * drag) commonly can't hand over real bytes on drag, only a reference: the
 * "DownloadURL" data (format "mime:filename:url", meant for dropping onto the
 * OS file explorer, which fetches it itself using the browser's own session)
 * or a plain "text/uri-list" pointing at the attachment. A web page can still
 * honor that by fetching the URL itself - it just needs Outlook's endpoint to
 * allow a cross-origin fetch with credentials, which it may or may not. Must
 * be called with strings already read synchronously off the drop event (see
 * onDrop) since DataTransfer access doesn't survive past the handler.
 */
async function fileFromUrlDrag(downloadUrl: string, uriList: string): Promise<File | null> {
  let name = '';
  let url = '';
  let mime = '';
  if (downloadUrl) {
    const parts = downloadUrl.split(':');
    if (parts.length >= 3) {
      mime = parts[0];
      name = parts[1];
      url = parts.slice(2).join(':');
    }
  }
  if (!url && uriList) {
    url = uriList.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
  }
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!name) {
      try {
        name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'attachment');
      } catch {
        name = 'attachment';
      }
    }
    return new File([blob], name, { type: mime || blob.type });
  } catch {
    return null;
  }
}

/** Run `worker` over `items`, at most `limit` in flight. Worker must not reject. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]);
    }
  });
  await Promise.all(lanes);
}

/** Built-in copy of framework/backend/api/base/documentGridSchema.ts, used when no `schemaName`
 *  is given (an app that hasn't registered per-module document grid schemas). Same columns. */
const DEFAULT_DOCUMENT_SCHEMA: ConvertedSchema = {
  entityName: 'Document',
  description: 'Documents',
  formTabs: null,
  relationships: {},
  idFieldName: 'document_id',
  parent: { entity: '', foreignKey: 'entity_id', label: 'Documents', actions: ['read', 'create', 'write', 'delete'] },
  entityFields: {},
  formFields: {
    description: { type: 'textarea', default: '', label: 'Description', dbField: 'description', showOn: ['list', 'form'], maxWidth: '380px', maxLength: MAX_DESCRIPTION } as any,
    doc_type: { type: 'select', default: DEFAULT_DOC_TYPE, label: 'Type', dbField: 'doc_type', showOn: ['list', 'form'], enumValues: [...DOC_TYPES], enumLabels: DOC_TYPE_LABELS } as any,
    file_name: { type: 'string', default: null, label: 'File', dbField: 'file_name', readOnly: true, showOn: ['list', 'form'] } as any,
    file_size: { type: 'number', default: null, label: 'Size', dbField: 'file_size', readOnly: true, showOn: ['list', 'form'] } as any,
    created_at: { type: 'date', default: null, label: 'Uploaded', dbField: 'created_at', readOnly: true, showOn: ['list', 'form'] } as any,
  },
};

export const DocumentsGrid: React.FC<DocumentsGridProps> = ({
  entityType,
  entityId,
  api,
  storage,
  readOnly = false,
  canCreate: canCreateProp,
  canEdit: canEditProp,
  canDelete: canDeleteProp,
  schemaName,
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  oversizeMessage,
  emptyMessage = 'No documents',
  classifyDocType,
  visibleDocTypes,
  title = 'Documents',
}) => {
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Non-error feedback the user has to act on (e.g. "open the saved .eml draft").
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);
  const [shareRow, setShareRow] = useState<DocumentRecord | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  // The row whose server-side email dialog is open — the fallback for browsers
  // that cannot hand a file to the OS share sheet.
  const [emailRow, setEmailRow] = useState<DocumentRecord | null>(null);
  // Bytes pulled ahead of the share click — see SHARE_PREFETCH_MAX_BYTES.
  const sharePrefetchRef = useRef<Promise<Blob> | null>(null);
  // Folder add: the picked-but-not-yet-confirmed batch, then its live progress.
  const [pendingFolder, setPendingFolder] = useState<FolderJob | null>(null);
  const [folderProgress, setFolderProgress] = useState<{ done: number; total: number } | null>(null);
  // Editable names for a drop-sourced batch (index-aligned with pendingFolder.files) -
  // a drag source can hand over a File with the wrong name (e.g. an inline email
  // image proxied to a random id), so the confirm dialog lets that be fixed
  // before upload/classification. Unused for folder-sourced batches.
  const [dropNames, setDropNames] = useState<string[]>([]);
  // Drag-and-drop over the table; a plain counter survives dragenter/dragleave
  // firing on child elements as the pointer crosses row boundaries.
  const [dragDepth, setDragDepth] = useState(0);

  // "+ Add" opens this picker directly: a document row only exists once its
  // file does, so there's no blank row to fill in first — description and
  // type are edited in place afterwards like any other cell.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Its own input: webkitdirectory can't be flipped per click on a live element.
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const cancelFolderRef = useRef(false);
  // Paste (Ctrl+V) can't rely on DOM focus landing on the grid container - most
  // of its area is covered by non-focusable table cells, so a click inside it
  // usually doesn't move focus there at all (focus only follows a click onto an
  // actually-focusable descendant). Tracking plain mouse hover instead - "hover
  // the grid, press Ctrl+V" - sidesteps that: no click required, nothing subtle
  // to explain. paste is still a document-level listener (below) so it fires
  // regardless of what, if anything, is focused.
  const gridHoverRef = useRef(false);
  const pasteHandlerRef = useRef<(e: ClipboardEvent) => void>(() => {});
  // Rows by id, kept from the grid's own list/update calls — delete needs the
  // storage path to drop the object after the metadata row goes.
  const docsById = useRef(new Map<number, DocumentRecord>());

  const recordId = entityId != null && entityId !== '' ? String(entityId) : null;
  // Per-action grants (<module>GridDocument:create/write/delete, or the old
  // all-or-nothing readOnly when the app doesn't pass them). The API enforces
  // the same split.
  const canCreate = (canCreateProp ?? !readOnly) && !!recordId;
  const canEdit = canEditProp ?? !readOnly;
  const canDelete = canDeleteProp ?? !readOnly;
  const disabled = !canCreate;
  const folderBusy = folderProgress !== null;

  /** Keep an auto-classified/manually-picked type inside visibleDocTypes when set. */
  const clampDocType = useCallback(
    (t: DocType): DocType => (!visibleDocTypes || visibleDocTypes.includes(t) ? t : visibleDocTypes[0] ?? DEFAULT_DOC_TYPE),
    [visibleDocTypes]
  );
  const sizeErrorFor = (file: File) =>
    oversizeMessage
      ? oversizeMessage(file, maxFileSize)
      : `"${file.name}" is ${formatFileSize(file.size)} — the limit is ${formatFileSize(maxFileSize)}.`;

  const reload = () => setReloadKey((k) => k + 1);

  /** The documents API in the shape ChildRowsGrid drives: rows load, edit and delete themselves. */
  const gridApi = useMemo<ChildRowsApi>(() => ({
    list: async (parentId) => {
      const rows = await api.list(entityType, String(parentId));
      docsById.current = new Map(rows.map((r) => [r.document_id, r]));
      return rows;
    },
    create: async () => {
      throw new Error('Documents are added by uploading a file');
    },
    update: async (_parentId, id, body) => {
      const item = await api.update(Number(id), {
        ...('description' in body ? { description: body.description ?? '' } : {}),
        ...('doc_type' in body ? { docType: body.doc_type as DocType } : {}),
      });
      docsById.current.set(item.document_id, item);
      return { item };
    },
    remove: async (_parentId, id) => {
      const row = docsById.current.get(Number(id));
      await api.remove(Number(id));
      // Metadata first, object second: an orphaned object is sweepable, an
      // orphaned row is a broken link in the grid.
      if (row?.storage_path) await storage.remove(row.storage_path).catch(() => undefined);
      docsById.current.delete(Number(id));
      return {};
    },
  }), [api, storage, entityType]);

  // React's input typings don't carry the directory attributes and JSX would
  // warn on the unknown props - set them on the DOM node instead.
  useEffect(() => {
    const el = folderInputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  // Registered once, at the document level, rather than as a React onPaste prop
  // on the grid itself - a click inside the grid usually doesn't move DOM focus
  // there (see gridHoverRef above), so a paste-only-when-focused handler on the
  // container would rarely fire. Always calling through the ref (reassigned
  // every render, just below) keeps this listener itself stable across renders
  // while still seeing current props/state.
  useEffect(() => {
    const listener = (e: ClipboardEvent) => pasteHandlerRef.current(e);
    document.addEventListener('paste', listener);
    return () => document.removeEventListener('paste', listener);
  }, []);

  /** Upload bytes, then write the metadata row; roll the object back if that fails. */
  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the same file twice still fires a change event.
    e.target.value = '';
    if (!file || !recordId) return;

    if (file.size > maxFileSize) {
      setError(sizeErrorFor(file));
      return;
    }

    const path = storagePathFor(entityType, recordId, file.name);
    const docType = clampDocType(classifyDocType ? classifyDocType(file) : DEFAULT_DOC_TYPE);
    setUploading(file.name);
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
          description: null,
          docType,
          mimeType: file.type || null,
          fileSize: file.size,
        });
      } catch (metaError) {
        await storage.remove(path).catch(() => undefined);
        throw metaError;
      }
      reload();
    } catch (err: any) {
      setError(err?.message || 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  /** Drop ignored/oversized files, keeping a note of what got skipped and why. */
  const triageFiles = (picked: File[]): { files: File[]; skipped: string[] } => {
    const files: File[] = [];
    const skipped: string[] = [];
    for (const file of picked) {
      if (file.name.startsWith('.') || IGNORED_FILE_NAMES.has(file.name)) continue;
      if (file.size > maxFileSize) {
        skipped.push(`${file.name} (${formatFileSize(file.size)})`);
        continue;
      }
      files.push(file);
    }
    return { files, skipped };
  };

  /** Folder picked: triage the files, then confirm before uploading the batch. */
  const handleFolderChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    // Reset now so re-picking the same folder still fires a change event.
    e.target.value = '';
    if (!picked.length || !recordId) return;

    const { files, skipped } = triageFiles(picked);
    if (!files.length) {
      setError(
        skipped.length
          ? `Every file in that folder is over the ${formatFileSize(maxFileSize)} limit.`
          : 'That folder has no files to upload.'
      );
      return;
    }
    setError(null);
    setPendingFolder({ source: 'folder', folderName: folderNameOf(picked[0]), files, skipped });
  };

  /** Files dropped straight onto the grid: same batch path as "Add Folder". */
  const handleFilesDropped = (dropped: File[], emptyDropNote?: string) => {
    if (!recordId || disabled || folderBusy) return;
    if (!dropped.length) {
      setError(emptyDropNote || 'Nothing to upload from that drop.');
      return;
    }
    const { files, skipped } = triageFiles(dropped);
    if (!files.length) {
      setError(
        skipped.length
          ? `Every dropped file is over the ${formatFileSize(maxFileSize)} limit.`
          : 'Nothing to upload from that drop.'
      );
      return;
    }
    setError(null);
    setDropNames(files.map((f) => f.name));
    setPendingFolder({ source: 'drop', folderName: '', files, skipped });
  };

  const closePendingFolder = () => {
    setPendingFolder(null);
    setDropNames([]);
  };

  // Gating on dataTransfer.types.includes('Files') here used to block drops from
  // Outlook entirely: for a drag originating outside the browser (Windows OLE
  // source, which is how Outlook hands off an attachment), Chromium often leaves
  // `types` empty until the actual `drop` event - dragover/dragenter never see
  // 'Files' even though the drop itself would have real data. Skipping
  // preventDefault() in that case is what produced the OS's not-allowed (red
  // circle-slash) cursor for the whole hover. So: always allow the hover here:
  // the drop handler has fully-populated data and is what actually decides
  // whether there's anything usable.
  const onDragOver = (e: React.DragEvent) => {
    if (disabled || folderBusy) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (disabled || folderBusy) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (disabled || folderBusy) return;
    e.preventDefault();
    setDragDepth((d) => Math.max(0, d - 1));
  };

  const onDrop = (e: React.DragEvent) => {
    if (disabled || folderBusy) return;
    e.preventDefault();
    setDragDepth(0);
    // Everything read off e.dataTransfer here (items, files, getData) must happen
    // synchronously in this handler - engines invalidate the drag data store once
    // it returns, so none of this can move into the async work below.
    const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    const rawFiles = Array.from(e.dataTransfer.files ?? []);
    const types = e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    // Whatever format name the source used, grab every value now - getData()
    // only works synchronously off the live event, same restriction as above.
    const dataByType: Record<string, string> = {};
    for (const t of types) {
      try { dataByType[t] = e.dataTransfer.getData(t); } catch { /* type not readable at 'drop' in this engine */ }
    }
    // eslint-disable-next-line no-console
    console.info('[DocumentsGrid] drop types/data:', { types, dataByType, itemKinds: items.map((i) => i.kind) });

    void (async () => {
      let files = await filesFromDroppedItems(items);
      if (!files.length && rawFiles.length) files = rawFiles;
      if (files.length) {
        handleFilesDropped(files);
        return;
      }

      // Known "attachment reference" formats first (parsed properly), then a
      // last-resort scan of every value for a bare http(s)/blob URL - some
      // sources only expose the reference via an unexpected type (e.g. inside
      // text/html markup) rather than DownloadURL/text/uri-list.
      const downloadUrl = dataByType['DownloadURL'] || dataByType['downloadurl'] || '';
      const uriList = dataByType['text/uri-list'] || '';
      let viaUrl = (downloadUrl || uriList) ? await fileFromUrlDrag(downloadUrl, uriList) : null;
      if (!viaUrl) {
        const urlMatch = Object.values(dataByType).join('\n').match(/https?:\/\/\S+|blob:\S+/);
        if (urlMatch) viaUrl = await fileFromUrlDrag('', urlMatch[0]);
      }
      if (viaUrl) {
        handleFilesDropped([viaUrl]);
        return;
      }

      // Outlook on the web's own attachment drag: a proprietary "attachment" JSON
      // payload (attachment ids + an internal auth token), never a real file or a
      // fetchable URL. It's designed to be understood only by Microsoft's own web
      // apps (OneDrive, SharePoint), which hold the Graph API session needed to
      // resolve it - a third-party site has no access to that token and never can.
      // Not a format we're missing; there's nothing here to fetch.
      const isOutlookWebAttachment = types.includes('attachment') && types.includes('chromium/x-drag-id');
      handleFilesDropped(
        [],
        isOutlookWebAttachment
          ? "Outlook on the web doesn't hand the browser the actual file on drag - only Microsoft's own apps can read that data. Try copying the attachment (Ctrl+C) and pasting here (click into the grid, then Ctrl+V) instead, or save it to disk (right-click → Save As, or drag it to your Desktop) and use +Add / Add Folder."
          : `Couldn't read a file from that drop${types.length ? ` (saw: ${types.join(', ')} - see console for full detail)` : ' (no drag data at all)'}. Save the attachment to disk first, then drag it in from there.`
      );
    })();
  };

  /**
   * Paste (Ctrl+V) onto the grid - a fallback for sources whose drag doesn't hand
   * over real file data (Outlook on the web's attachment drag, notably): copying a
   * file to the OS clipboard is a more standardized path than a website's custom
   * drag payload, so it has a real chance of working where the drop didn't.
   * ClipboardEvent.clipboardData is the same DataTransfer interface as a drop
   * event's, so this reuses filesFromDroppedItems() as-is (entry -> virtual-file
   * handle -> getAsFile fallback chain, all unchanged).
   * Guarded to ignore paste inside an actual text field (draft description, etc.)
   * so normal text pasting there isn't hijacked, and gated on gridHoverRef so an
   * unrelated paste elsewhere on the page doesn't get grabbed just because this
   * is a document-level listener (see the effect above).
   */
  const onPaste = (e: ClipboardEvent) => {
    if (disabled || folderBusy) return;
    if (!gridHoverRef.current) {
      // eslint-disable-next-line no-console
      console.info('[DocumentsGrid] paste seen but grid not hovered - ignored.');
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    const cd = e.clipboardData;
    const items = cd?.items ? Array.from(cd.items) : [];
    const rawFiles = cd?.files ? Array.from(cd.files) : [];
    const types = cd?.types ? Array.from(cd.types) : [];
    const dataByType: Record<string, string> = {};
    for (const t of types) {
      try { dataByType[t] = cd!.getData(t); } catch { /* type not readable at 'paste' in this engine */ }
    }
    // Logged unconditionally (while hovering) so a paste that turns out to carry
    // no file data still shows exactly what WAS on the clipboard, instead of
    // looking identical to "the listener never fired at all".
    // eslint-disable-next-line no-console
    console.info('[DocumentsGrid] paste types/data:', { hasClipboardData: !!cd, types, dataByType, itemKinds: items.map((i) => i.kind) });
    if (!cd) return;

    // Only treat this as a file-paste attempt when there's something more than
    // ordinary copied text/rich-text on the clipboard - otherwise a completely
    // unrelated paste elsewhere on the page (grid just happens to be hovered)
    // would show a spurious "couldn't read a file" error.
    const TEXT_ONLY_TYPES = new Set(['text/plain', 'text/html', 'text/rtf']);
    const looksLikeFile =
      items.some((i) => i.kind === 'file') || rawFiles.length > 0 || types.some((t) => !TEXT_ONLY_TYPES.has(t.toLowerCase()));
    if (!looksLikeFile) return;
    e.preventDefault();

    void (async () => {
      let files = await filesFromDroppedItems(items);
      if (!files.length && rawFiles.length) files = rawFiles;
      if (files.length) {
        handleFilesDropped(files);
        return;
      }
      handleFilesDropped(
        [],
        `Couldn't read a file from that paste either${types.length ? ` (saw: ${types.join(', ')} - see console for full detail)` : ''}. Save the attachment to disk (right-click → Save As), then use +Add / Add Folder.`
      );
    })();
  };
  // Reassigned every render so the stable document listener (effect above)
  // always calls through to this render's closure - current disabled/folderBusy
  // included - without needing to re-register the native listener itself.
  pasteHandlerRef.current = onPaste;

  /**
   * Upload a confirmed folder: one document row per file, subfolder path kept as
   * the description. Files are independent - a failure is collected and reported
   * at the end rather than aborting the rest of the batch.
   */
  /** Apply any edited names from the confirm dialog before upload - a no-op for folder-sourced jobs. */
  const withDropNamesApplied = (job: FolderJob): FolderJob => {
    if (job.source !== 'drop') return job;
    return {
      ...job,
      files: job.files.map((file, i) => {
        const name = dropNames[i]?.trim();
        return name && name !== file.name ? new File([file], name, { type: file.type }) : file;
      }),
    };
  };

  const uploadFolder = async (job: FolderJob) => {
    if (!recordId) return;
    closePendingFolder();
    cancelFolderRef.current = false;
    setFolderProgress({ done: 0, total: job.files.length });
    const failures: string[] = [];

    await runPool(job.files, FOLDER_CONCURRENCY, async (file) => {
      if (cancelFolderRef.current) return;
      const path = storagePathFor(entityType, recordId, file.name);
      try {
        await storage.upload(path, file);
        try {
          await api.create({
            entityType,
            entityId: recordId,
            fileName: file.name,
            storageBucket: storage.bucket,
            storagePath: path,
            description: relativeDirOf(file) || null,
            docType: clampDocType(classifyDocType ? classifyDocType(file) : DEFAULT_DOC_TYPE),
            mimeType: file.type || null,
            fileSize: file.size,
          });
        } catch (metaError) {
          await storage.remove(path).catch(() => undefined);
          throw metaError;
        }
      } catch (err: any) {
        failures.push(`${file.name}: ${err?.message || 'upload failed'}`);
      } finally {
        setFolderProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    });

    const cancelled = cancelFolderRef.current;
    cancelFolderRef.current = false;
    setFolderProgress(null);
    reload();

    const notes: string[] = [];
    if (cancelled) notes.push('Upload cancelled - files already sent were kept.');
    if (failures.length) {
      const head = failures.slice(0, 3).join('; ');
      notes.push(`${failures.length} of ${job.files.length} file(s) failed: ${head}${failures.length > 3 ? '...' : ''}`);
    }
    if (job.skipped.length) {
      const head = job.skipped.slice(0, 3).join(', ');
      notes.push(`Skipped (over ${formatFileSize(maxFileSize)}): ${head}${job.skipped.length > 3 ? '...' : ''}`);
    }
    setError(notes.length ? notes.join(' ') : null);
  };

  const openFile = async (row: DocumentRecord) => {
    if (!row.storage_path) return;
    // xlsx/xls/csv can't render in a plain browser tab — it just downloads.
    // Open a dedicated editor tab instead, when the viewer can save it back.
    if (canEdit && isEditableTabularFile(row.file_name)) {
      openXlsxEditorWindow({ doc: row, entityType, recordId: recordId!, api, storage, onSaved: reload });
      return;
    }
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

  const onShare = async (row: DocumentRecord, anchor: HTMLElement) => {
    setShareRow(row);
    setShareAnchor(anchor);
    setShareUrl(null);
    sharePrefetchRef.current = null;
    if (!row.storage_path) return;
    try {
      const url = await storage.viewUrl(row.storage_path);
      setShareUrl(url);
      if (canShareFiles() && (row.file_size ?? 0) <= SHARE_PREFETCH_MAX_BYTES) {
        const bytes = fetchFileBlob(url);
        // Nobody may ever await this one (menu dismissed) — don't let it surface
        // as an unhandled rejection.
        bytes.catch(() => {});
        sharePrefetchRef.current = bytes;
      }
    } catch (e: any) {
      setError(e?.message || 'Could not create share link');
      setShareAnchor(null);
    }
  };

  const closeShare = () => {
    setShareAnchor(null);
    setShareRow(null);
    setShareUrl(null);
    sharePrefetchRef.current = null;
  };

  const onCopyShareLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch (e: any) {
      setError(e?.message || 'Could not copy link');
    }
    closeShare();
  };

  const onOpenShareInBrowser = () => {
    if (!shareUrl) return;
    // Same rule as the file-name/open-icon click: xlsx/xls/csv edit in place
    // rather than just opening the raw signed URL (which only downloads it).
    if (shareRow && recordId && canEdit && isEditableTabularFile(shareRow.file_name)) {
      openXlsxEditorWindow({ doc: shareRow, entityType, recordId, api, storage, onSaved: reload });
      closeShare();
      return;
    }
    window.open(shareUrl, '_blank', 'noopener');
    closeShare();
  };

  /**
   * Hands the file to the OS share sheet, so the mail app opens with it already
   * attached and nothing lands in the user's downloads. Browsers without file
   * sharing (Firefox) get the server-side send dialog instead — same outcome,
   * still no download.
   */
  const onEmailClick = async () => {
    if (!shareRow?.storage_path || !shareUrl) return;
    const row = shareRow;
    const url = shareUrl;
    const prefetched = sharePrefetchRef.current;
    closeShare();
    try {
      const result = await shareDocumentFile({
        fileName: row.file_name || 'document',
        data: await (prefetched ?? fetchFileBlob(url)),
        mimeType: row.mime_type,
        // Subject only (the file name without its extension). No `text`: a share
        // carrying text as well as a file lets the mail app populate fields from
        // it, and this draft is meant to open with nothing but the attachment.
      });
      if (result === 'unsupported') setEmailRow(row);
    } catch (e: any) {
      setError(e?.message || 'Could not share the file');
    }
  };

  const onDownloadShareClick = () => {
    if (!shareRow || !shareUrl) return;
    window.location.assign(downloadUrlFor(shareUrl, shareRow.file_name));
    closeShare();
  };

  /** File column: open + share, then the name. Size gets the human-readable format. */
  const renderCell = (row: Record<string, any>, column: string): React.ReactNode | undefined => {
    if (column === 'file_size') {
      return <div className="editable-data-grid__display">{formatFileSize(row.file_size)}</div>;
    }
    if (column !== 'file_name') return undefined;
    const doc = row as DocumentRecord;
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <Tooltip title="Share">
          <span>
            <IconButton size="small" onClick={(e) => void onShare(doc, e.currentTarget)} disabled={!doc.storage_path}>
              <ShareIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Typography
          variant="body2"
          onClick={() => doc.storage_path && void openFile(doc)}
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            cursor: doc.storage_path ? 'pointer' : 'default',
            '&:hover': doc.storage_path ? { textDecoration: 'underline' } : undefined,
          }}
          title={doc.file_name}
        >
          {doc.file_name}
        </Typography>
      </Box>
    );
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="info" onClose={() => setNotice(null)} sx={{ mb: 1 }}>
          {notice}
        </Alert>
      )}
      {!recordId && (
        <Alert severity="info" sx={{ mb: 1 }}>
          Save this record before attaching documents.
        </Alert>
      )}

      {(folderProgress || uploading) && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {folderProgress ? `Uploading ${folderProgress.done} of ${folderProgress.total}...` : `Uploading ${uploading}...`}
            </Typography>
            {folderProgress && (
              <Button size="small" onClick={() => { cancelFolderRef.current = true; }}>
                Cancel
              </Button>
            )}
          </Box>
          <LinearProgress
            variant={folderProgress ? 'determinate' : 'indeterminate'}
            value={folderProgress?.total ? (folderProgress.done / folderProgress.total) * 100 : 0}
          />
        </Box>
      )}

      {recordId && (
        <ChildRowsGrid
          schemaName={schemaName}
          schema={schemaName ? undefined : DEFAULT_DOCUMENT_SCHEMA}
          parentId={recordId}
          api={gridApi}
          title={title}
          canCreate={canCreate}
          canEdit={canEdit}
          canDelete={canDelete}
          busy={folderBusy || !!uploading}
          onAddClick={() => fileInputRef.current?.click()}
          reloadKey={reloadKey}
          emptyMessage={emptyMessage}
          rowFilter={visibleDocTypes ? (r) => visibleDocTypes.includes(r.doc_type) : undefined}
          enumOverrides={visibleDocTypes ? { doc_type: { values: visibleDocTypes, labels: DOC_TYPE_LABELS } } : { doc_type: { labels: DOC_TYPE_LABELS } }}
          renderCell={renderCell}
          deleteConfirmText={(r) => `Delete "${r.file_name}"? The file is removed from storage and cannot be recovered.`}
          titleAdornment={canCreate ? (
            <Tooltip title="Drag and drop one or more files — or a whole folder — anywhere onto this grid to upload them. You can also copy a file and paste (Ctrl+V) while hovering the grid.">
              <IconButton size="small">
                <InfoOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : undefined}
          toolbarActions={canCreate ? (
            <Tooltip title="Upload every file in a folder">
              <span>
                <Button
                  variant="contained"
                  color="primary"
                  size="small"
                  startIcon={<DriveFolderUploadIcon fontSize="small" />}
                  onClick={() => folderInputRef.current?.click()}
                  disabled={folderBusy || !!uploading}
                  className="editable-data-grid__add-button"
                >
                  Folder
                </Button>
              </span>
            </Tooltip>
          ) : undefined}
          containerProps={{
            onDragOver,
            onDragEnter,
            onDragLeave,
            onDrop,
            onMouseEnter: () => { gridHoverRef.current = true; },
            onMouseLeave: () => { gridHoverRef.current = false; },
          }}
          containerSx={
            dragDepth > 0
              ? { outline: '2px dashed', outlineColor: 'primary.main', outlineOffset: '-2px', bgcolor: 'action.hover' }
              : undefined
          }
        />
      )}

      <input ref={fileInputRef} type="file" hidden onChange={handleFileChosen} />
      <input ref={folderInputRef} type="file" hidden multiple onChange={handleFolderChosen} />

      <Dialog open={!!pendingFolder} onClose={closePendingFolder} maxWidth="sm" fullWidth={pendingFolder?.source === 'drop'}>
        <DialogTitle>{pendingFolder?.source === 'folder' ? 'Add folder' : 'Add files'}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Upload {pendingFolder?.files.length} file(s) ({formatFileSize(
              (pendingFolder?.files ?? []).reduce((sum, f) => sum + f.size, 0)
            )})
            {pendingFolder?.source === 'folder' ? ` from "${pendingFolder.folderName}"` : ''}
            ? Each one becomes its own document row.
          </DialogContentText>
          {pendingFolder?.source === 'drop' && (
            <>
              <DialogContentText sx={{ mt: 1.5, mb: 0.5 }} variant="body2">
                File name (a drag from an email can lose the real name — fix it here so the type auto-sets correctly):
              </DialogContentText>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 320, overflowY: 'auto' }}>
                {pendingFolder.files.map((file, i) => (
                  <TextField
                    key={i}
                    size="small"
                    fullWidth
                    value={dropNames[i] ?? file.name}
                    onChange={(e) => setDropNames((ns) => ns.map((n, j) => (j === i ? e.target.value : n)))}
                    helperText={formatFileSize(file.size)}
                  />
                ))}
              </Box>
            </>
          )}
          {!!pendingFolder?.skipped.length && (
            <DialogContentText sx={{ mt: 1 }} color="warning.main">
              {pendingFolder.skipped.length} file(s) over the {formatFileSize(maxFileSize)} limit will be skipped.
            </DialogContentText>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closePendingFolder}>Cancel</Button>
          <Button onClick={() => pendingFolder && void uploadFolder(withDropNamesApplied(pendingFolder))} variant="contained">
            Upload
          </Button>
        </DialogActions>
      </Dialog>

      <ShareMenu
        anchorEl={shareAnchor}
        onClose={closeShare}
        onOpen={onOpenShareInBrowser}
        onEmail={() => void onEmailClick()}
        onCopyLink={() => void onCopyShareLink()}
        onDownload={onDownloadShareClick}
        ready={!!shareUrl}
      />

      {emailRow && (
        <EmailDocumentDialog
          open
          onClose={() => setEmailRow(null)}
          fileName={emailRow.file_name}
          fileSizeLabel={formatFileSize(emailRow.file_size) || undefined}
          defaultMessage={emailRow.description || undefined}
          onSend={(input) => api.email(emailRow.document_id, input)}
          onSent={(recipients) => setNotice(`Sent ${emailRow.file_name} to ${recipients.join(', ')}.`)}
        />
      )}
    </Box>
  );
};

export default DocumentsGrid;
