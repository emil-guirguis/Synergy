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
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
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
import DriveFolderUploadIcon from '@mui/icons-material/DriveFolderUpload';
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
  /** Auto-set doc_type for dropped/folder files. Falls back to DEFAULT_DOC_TYPE when omitted. */
  classifyDocType?: (file: File) => DocType;
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
// Parallel folder uploads: enough to hide per-file latency, low enough that a
// big folder doesn't open dozens of connections to the bucket at once.
const FOLDER_CONCURRENCY = 3;
// OS/editor droppings nobody means to attach; dotfiles are dropped as well.
const IGNORED_FILE_NAMES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);

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
  classifyDocType,
}) => {
  const [rows, setRows] = useState<DocumentRecord[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
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

  // One hidden input reused by every row; the draft it belongs to is stashed
  // here at click time so the change handler knows which row to complete.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingDraftRef = useRef<DraftRow | null>(null);
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

  const recordId = entityId != null && entityId !== '' ? String(entityId) : null;
  const disabled = readOnly || !recordId;
  const folderBusy = folderProgress !== null;

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
    // Auto-classify only if the type dropdown is still untouched - a manual
    // pick (including manually setting it back to "Other") always wins.
    const docType = draft.docType === DEFAULT_DOC_TYPE && classifyDocType ? classifyDocType(file) : draft.docType;
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
          docType,
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
            docType: classifyDocType ? classifyDocType(file) : DEFAULT_DOC_TYPE,
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
    await load();

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

      {folderProgress && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              Uploading {folderProgress.done} of {folderProgress.total}...
            </Typography>
            <Button size="small" onClick={() => { cancelFolderRef.current = true; }}>
              Cancel
            </Button>
          </Box>
          <LinearProgress
            variant="determinate"
            value={folderProgress.total ? (folderProgress.done / folderProgress.total) * 100 : 0}
          />
        </Box>
      )}

      {!disabled && !readOnly && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Drag files here, or hover the grid and press Ctrl+V to paste a copied file.
        </Typography>
      )}

      <TableContainer
        component={Paper}
        variant="outlined"
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onMouseEnter={() => { gridHoverRef.current = true; }}
        onMouseLeave={() => { gridHoverRef.current = false; }}
        sx={
          dragDepth > 0
            ? { outline: '2px dashed', outlineColor: 'primary.main', outlineOffset: '-2px', bgcolor: 'action.hover' }
            : undefined
        }
      >
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '38%' }}>Description</TableCell>
              <TableCell sx={{ width: '14%' }}>Type</TableCell>
              <TableCell sx={{ width: '28%' }}>File</TableCell>
              <TableCell sx={{ width: '10%' }}>Size</TableCell>
              <TableCell sx={{ width: '10%' }}>Uploaded</TableCell>
              {!readOnly && (
                <TableCell align="right" sx={{ width: '190px' }}>
                  <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end' }}>
                    <Button
                      size="small"
                      onClick={() => setDrafts((ds) => [...ds, newDraft()])}
                      disabled={disabled || folderBusy}
                    >
                      + Add
                    </Button>
                    <Tooltip title="Upload every file in a folder">
                      <span>
                        <Button
                          size="small"
                          startIcon={<DriveFolderUploadIcon fontSize="small" />}
                          onClick={() => folderInputRef.current?.click()}
                          disabled={disabled || folderBusy}
                        >
                          Add Folder
                        </Button>
                      </span>
                    </Tooltip>
                  </Box>
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
