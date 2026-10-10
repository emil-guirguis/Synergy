/**
 * Resources tab — admin document manager.
 *
 * Ports the tbwc-site "Rep Portal" admin card (admin.html): upload PDFs into a
 * category / subcategory tree in the shared private `rep-docs` bucket, browse the
 * tree, and delete / rename files. Reps see the read-only side on tbwc-site's
 * portal.html; this is the admin-only management side.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Collapse,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import FolderIcon from '@mui/icons-material/Folder';
import DescriptionIcon from '@mui/icons-material/Description';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import DownloadIcon from '@mui/icons-material/Download';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ShareIcon from '@mui/icons-material/Share';
import IosShareIcon from '@mui/icons-material/IosShare';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EmailIcon from '@mui/icons-material/Email';
import {
  listDocsTree,
  loadRootChildren,
  loadFolderChildren,
  uploadDoc,
  removeDoc,
  moveDoc,
  signedDownloadUrl,
  signedViewUrl,
  type DocTree,
  type DocFile,
  type DocCategory,
} from '../../services/storageService';
import {
  getDocTypes,
  setDocType,
  renameDocType,
  deleteDocType,
  type DocType,
} from '../../services/docTypeService';

const NEW = '__new__';
const TYPE_LABEL: Record<DocType, string> = { rep: 'Rep', employee: 'Employee', all: 'All' };

/** A file or folder with no row of its own inherits the nearest ancestor folder's
 * type (same table, folder paths are keys too); no row anywhere up the chain
 * defaults to 'all' (visible to everyone). */
function typeOf(docTypes: Record<string, DocType>, path: string): DocType {
  let p = path;
  for (;;) {
    if (docTypes[p] != null) return docTypes[p];
    const slash = p.lastIndexOf('/');
    if (slash < 0) return 'all';
    p = p.slice(0, slash);
  }
}

/** Keep only files passing `keep`, recursively; prune folders left with nothing under them. */
function filterCategory(cat: DocCategory, keep: (f: DocFile) => boolean): DocCategory | null {
  const files = cat.files.filter(keep);
  const subs = cat.subs.map((s) => filterCategory(s, keep)).filter((s): s is DocCategory => s !== null);
  if (files.length === 0 && subs.length === 0) return null;
  return { ...cat, files, subs };
}

/** Drop files that don't match `typeSel` ('all' = no filtering); prune emptied folders, any depth. */
function filterTree(tree: DocTree, docTypes: Record<string, DocType>, typeSel: DocType): DocTree {
  if (typeSel === 'all') return tree;
  const keep = (f: DocFile) => {
    const t = typeOf(docTypes, f.path);
    return t === 'all' || t === typeSel;
  };
  const rootFiles = tree.rootFiles.filter(keep);
  const categories = tree.categories
    .map((c) => filterCategory(c, keep))
    .filter((c): c is DocCategory => c !== null);
  return { rootFiles, categories };
}

function fmtSize(bytes?: number): string {
  if (bytes == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${u[i]}`;
}

const DRAG_MIME = 'application/x-doc-paths';

interface DroppedFile {
  file: File;
  /** Path relative to the dragged root(s), "/"-joined — preserves nested folders. */
  relPath: string;
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** Recurse into an OS drag-drop entry (file or folder), any depth, collecting every file found. */
async function walkEntry(entry: FileSystemEntry, out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    out.push({ file, relPath: entry.fullPath.replace(/^\/+/, '') });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries() returns at most a batch at a time — keep calling until it's empty.
    let batch: FileSystemEntry[];
    do {
      batch = await readDirEntries(reader);
      for (const e of batch) await walkEntry(e, out);
    } while (batch.length > 0);
  }
}

/** Expand an OS drag-drop (loose files and/or whole folders) into a flat list, folders walked recursively. */
async function readDroppedTree(dt: DataTransfer): Promise<DroppedFile[]> {
  // webkitGetAsEntry() must be called synchronously while the drop event is live — do it
  // before any `await` so `dt.items` is still valid.
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const entry = dt.items[i].webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  const out: DroppedFile[] = [];
  for (const entry of entries) await walkEntry(entry, out);
  return out;
}

/** Paths dropped from a FileRow drag — one or many (multi-select). */
function readDragPaths(dt: DataTransfer): string[] {
  const raw = dt.getData(DRAG_MIME) || dt.getData('text/plain');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((p) => typeof p === 'string');
  } catch {
    // Not JSON — a plain single path.
  }
  return [raw];
}

/** Replace the node at `path` (any depth, "/"-joined) with `updater(node)`, immutably. */
function updateTreeAt(tree: DocTree, path: string, updater: (cat: DocCategory) => DocCategory): DocTree {
  const segs = path.split('/');
  function recur(cats: DocCategory[], idx: number): DocCategory[] {
    return cats.map((c) => {
      if (c.name !== segs[idx]) return c;
      if (idx === segs.length - 1) return updater(c);
      return { ...c, subs: recur(c.subs, idx + 1) };
    });
  }
  return { ...tree, categories: recur(tree.categories, 0) };
}

/** Find the folder node at `dir` (any depth, "/"-joined path), or null if it doesn't exist. */
function folderAt(tree: DocTree, dir: string): DocCategory | null {
  const segs = dir.split('/');
  let cats = tree.categories;
  let found: DocCategory | null = null;
  for (const seg of segs) {
    found = cats.find((c) => c.name === seg) ?? null;
    if (!found) return null;
    cats = found.subs;
  }
  return found;
}

/** Files currently listed directly under `dir` ("" = bucket root, else any depth). */
function filesAt(tree: DocTree, dir: string): DocFile[] {
  if (!dir) return tree.rootFiles;
  return folderAt(tree, dir)?.files ?? [];
}

/** Insert " (2)", " (3)", … before the extension until `taken` no longer has it. */
function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  let candidate = `${base} (${n})${ext}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

/** No "/" (would fake nesting) or leading dots in a path segment. */
function cleanSeg(s: string): string {
  return String(s || '')
    .trim()
    .replace(/[/\\]+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
}

type Msg = { text: string; severity: 'success' | 'error' } | null;

export default function ResourcesTab({ readOnly = false }: { readOnly?: boolean }) {
  const [tree, setTree] = useState<DocTree>({ rootFiles: [], categories: [] });
  const [docTypes, setDocTypes] = useState<Record<string, DocType>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<Msg>(null);
  const [uploading, setUploading] = useState(false);

  // Upload form. `typeSel` also drives the tree filter below (picking a type
  // both sets what the next upload is tagged with and filters the view).
  const [catSel, setCatSel] = useState('');
  const [catNew, setCatNew] = useState('');
  const [subSel, setSubSel] = useState('');
  const [subNew, setSubNew] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [typeSel, setTypeSel] = useState<DocType>('all');

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  // Default: lazy per-folder loading (fast — one request per expand). Checking this
  // trades that for one full recursive walk, needed to show accurate folder counts.
  const [showCounts, setShowCounts] = useState(false);

  // Multi-select for bulk drag-and-drop moves.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const load = useCallback(async (full = showCounts) => {
    setLoading(true);
    try {
      const [t, dt] = await Promise.all([
        full ? listDocsTree() : loadRootChildren(),
        getDocTypes().catch(() => ({})),
      ]);
      setTree(t);
      setDocTypes(dt);
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not load resources', severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, [showCounts]);

  async function onToggleShowCounts(checked: boolean) {
    setShowCounts(checked);
    if (checked) await load(true);
  }

  /** Fetch a folder's children the first time it's expanded — no-op once loaded. */
  async function ensureFolderLoaded(cat: DocCategory) {
    if (cat.loaded !== false) return;
    try {
      const { files, subs } = await loadFolderChildren(cat.path);
      setTree((t) => updateTreeAt(t, cat.path, (c) => ({ ...c, files, subs, loaded: true })));
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not load folder', severity: 'error' });
    }
  }

  /** Parent directory of `path` ("" = root). */
  function dirOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(0, slash) : '';
  }

  /** Re-fetch root + every ancestor down to `dir` after a mutation, merging onto the
   * existing tree (preserves other already-loaded folders instead of collapsing them).
   * Works the same whether or not `showCounts` is on — a folder already `loaded: true`
   * stays that way for everything untouched by the mutation, so counts stay accurate. */
  async function refreshPath(dir: string) {
    try {
      const rootShallow = await loadRootChildren();
      setTree((t) => {
        const byName = new Map(t.categories.map((c) => [c.name, c]));
        const categories = rootShallow.categories.map((stub) => byName.get(stub.name) ?? stub);
        return { rootFiles: rootShallow.rootFiles, categories };
      });
      if (!dir) return;
      const segs = dir.split('/');
      let acc = '';
      for (const seg of segs) {
        acc = acc ? `${acc}/${seg}` : seg;
        const { files, subs } = await loadFolderChildren(acc);
        setTree((t) =>
          updateTreeAt(t, acc, (c) => {
            const byName = new Map(c.subs.map((s) => [s.name, s]));
            const mergedSubs = subs.map((stub) => byName.get(stub.name) ?? stub);
            return { ...c, files, subs: mergedSubs, loaded: true };
          })
        );
      }
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not refresh', severity: 'error' });
    }
  }

  // Reps only ever see 'all' + 'rep' docs — 'employee' stays hidden regardless of typeSel.
  const filteredTree = useMemo(() => {
    if (readOnly) {
      const keep = (f: DocFile) => typeOf(docTypes, f.path) !== 'employee';
      const rootFiles = tree.rootFiles.filter(keep);
      const categories = tree.categories
        .map((c) => filterCategory(c, keep))
        .filter((c): c is DocCategory => c !== null);
      return { rootFiles, categories };
    }
    return filterTree(tree, docTypes, typeSel);
  }, [tree, docTypes, typeSel, readOnly]);

  async function onTypeChange(path: string, type: DocType) {
    const prev = typeOf(docTypes, path);
    setDocTypes((d) => ({ ...d, [path]: type }));
    try {
      await setDocType(path, type);
    } catch (e) {
      setDocTypes((d) => ({ ...d, [path]: prev }));
      setMsg({ text: (e as Error).message || 'Could not update type', severity: 'error' });
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  // Subcategory options depend on the chosen (existing) category — fetch it lazily
  // the moment it's picked, same as expanding it in the tree view.
  useEffect(() => {
    if (!catSel || catSel === NEW) return;
    const match = tree.categories.find((c) => c.name === catSel);
    if (match) void ensureFolderLoaded(match);
  }, [catSel, tree.categories]);

  const subOptions = useMemo(() => {
    const match = tree.categories.find((c) => c.name === catSel);
    return match ? match.subs.map((s) => s.name) : [];
  }, [tree, catSel]);

  const resolvedCat = catSel === NEW ? cleanSeg(catNew) : cleanSeg(catSel);
  const resolvedSub = subSel === NEW ? cleanSeg(subNew) : cleanSeg(subSel);

  async function onUpload() {
    if (!resolvedCat) {
      setMsg({ text: 'Category is required — pick one or add new.', severity: 'error' });
      return;
    }
    if (!files.length) {
      setMsg({ text: 'Choose a file first.', severity: 'error' });
      return;
    }
    const prefix = resolvedCat + (resolvedSub ? `/${resolvedSub}` : '');
    setUploading(true);
    setMsg({ text: 'Uploading…', severity: 'success' });
    try {
      for (const file of files) {
        const path = `${prefix}/${file.name}`;
        await uploadDoc(path, file);
        try {
          await setDocType(path, typeSel);
        } catch {
          // Best-effort — the file itself uploaded fine, it just defaults to 'all'.
        }
      }
      setMsg({ text: `Uploaded ${files.length} file(s) to ${prefix}`, severity: 'success' });
      setFiles([]);
      await refreshPath(prefix);
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Upload failed', severity: 'error' });
    } finally {
      setUploading(false);
    }
  }

  async function onDelete(path: string) {
    if (!window.confirm(`Delete "${path}"?\nReps will no longer see it.`)) return;
    try {
      await removeDoc(path);
      try {
        await deleteDocType(path);
      } catch {
        // Best-effort cleanup — the file is gone either way.
      }
      setMsg({ text: `Deleted ${path}`, severity: 'success' });
      await refreshPath(dirOf(path));
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Delete failed', severity: 'error' });
    }
  }

  /** Storage folders are implicit (just a shared path prefix) — only delete-able when
   * genuinely empty. Always re-fetches fresh before deciding, since the tree's local
   * copy of this folder may be stale or an unexpanded lazy stub. */
  async function onDeleteFolder(cat: DocCategory) {
    if (!window.confirm(`Delete "${cat.path}"? Only works if it's empty.`)) return;
    try {
      const { files, subs } = await loadFolderChildren(cat.path);
      if (files.length > 0 || subs.length > 0) {
        setMsg({
          text: `Can't delete "${cat.path}" — it still has ${files.length} file(s) and ${subs.length} subfolder(s). Remove those first.`,
          severity: 'error',
        });
        return;
      }
      try {
        await removeDoc(`${cat.path}/.emptyFolderPlaceholder`);
      } catch {
        // No placeholder object to remove — Storage already has nothing under this prefix.
      }
      try {
        await deleteDocType(cat.path);
      } catch {
        // Best-effort cleanup — the folder is gone either way.
      }
      setMsg({ text: `Deleted ${cat.path}`, severity: 'success' });
      await refreshPath(dirOf(cat.path));
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not delete folder', severity: 'error' });
    }
  }

  async function onDownload(path: string) {
    try {
      const url = await signedDownloadUrl(path);
      window.location.assign(url);
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Download failed', severity: 'error' });
    }
  }

  async function onOpen(path: string) {
    try {
      const url = await signedViewUrl(path);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not open resource', severity: 'error' });
    }
  }

  async function onShare(path: string, anchor: HTMLElement) {
    setSharePath(path);
    setShareAnchor(anchor);
    setShareUrl(null);
    try {
      const url = await signedViewUrl(path);
      setShareUrl(url);
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not create share link', severity: 'error' });
      setShareAnchor(null);
    }
  }

  function closeShare() {
    setShareAnchor(null);
    setSharePath(null);
    setShareUrl(null);
  }

  async function onCopyShareLink() {
    if (!shareUrl) return;
    try {
      // Plain writeText pastes as a bare URL string, which some rich-text targets
      // (Outlook, Word, Slack) don't auto-linkify. Also write text/html with a real
      // <a> so a rich paste always lands as a clickable link, not just text.
      if (typeof ClipboardItem !== 'undefined') {
        const esc = shareUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([shareUrl], { type: 'text/plain' }),
            'text/html': new Blob([`<a href="${esc}">${esc}</a>`], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(shareUrl);
      }
      setMsg({ text: 'Link copied to clipboard', severity: 'success' });
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not copy link', severity: 'error' });
    }
    closeShare();
  }

  function onOpenInBrowser() {
    if (!shareUrl) return;
    window.open(shareUrl, '_blank', 'noopener');
    closeShare();
  }

  async function onDownloadFromShare() {
    if (!sharePath) return;
    await onDownload(sharePath);
    closeShare();
  }

  /** Opens the user's own mail client with a draft pointing at the file. Signs
   *  its own long-lived URL rather than reusing `shareUrl` (that one's 60s,
   *  meant for the Browser/Download actions' immediate use — dead by the time
   *  an emailed draft actually gets sent and opened). The recipient's own mail
   *  client auto-linkifies the bare URL once the email is actually delivered. */
  async function onEmailShare() {
    if (!sharePath) return;
    try {
      const name = sharePath.slice(sharePath.lastIndexOf('/') + 1);
      const longUrl = await signedViewUrl(sharePath, 60 * 60 * 24 * 7);
      const subject = encodeURIComponent(name);
      const body = encodeURIComponent(`Click here to open the document:\n\n${longUrl}`);
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not create share link', severity: 'error' });
    }
    closeShare();
  }

  async function onMoveFiles(paths: string[], targetDir: string) {
    const toMove = paths.filter((path) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const newPath = targetDir ? `${targetDir}/${name}` : name;
      return newPath !== path;
    });
    if (!toMove.length) return;

    // Names already sitting in the target dir — extended as we place each moved
    // file, so two selected files sharing a name don't collide with each other
    // (Storage's move has no upsert; landing two files on one path fails the 2nd).
    const takenNames = new Set(filesAt(tree, targetDir).map((f) => f.name));
    let moved = 0;
    let renamed = 0;
    let failed = 0;
    let lastError = '';
    for (const path of toMove) {
      const origName = path.slice(path.lastIndexOf('/') + 1);
      const name = dedupeName(origName, takenNames);
      const newPath = targetDir ? `${targetDir}/${name}` : name;
      try {
        await moveDoc(path, newPath);
        takenNames.add(name);
        if (name !== origName) renamed++;
        try {
          await renameDocType(path, newPath);
        } catch {
          // Best-effort — the move itself succeeded either way.
        }
        moved++;
      } catch (e) {
        failed++;
        lastError = (e as Error).message || String(e);
      }
    }
    setSelected(new Set());
    if (failed === 0) {
      const suffix = renamed ? ` (${renamed} renamed to avoid a name clash)` : '';
      setMsg({
        text:
          moved === 1
            ? `Moved 1 file to ${targetDir || '(root)'}${suffix}`
            : `Moved ${moved} files to ${targetDir || '(root)'}${suffix}`,
        severity: 'success',
      });
    } else {
      setMsg({
        text: `Moved ${moved} file(s), ${failed} failed: ${lastError}`,
        severity: 'error',
      });
    }
    const dirs = new Set([targetDir, ...toMove.map((p) => dirOf(p))]);
    for (const dir of dirs) await refreshPath(dir);
  }

  /** OS drag-drop of files/folders onto the tree — uploads each, preserving nested folder structure under `targetDir`. */
  async function onUploadDropped(dropped: DroppedFile[], targetDir: string) {
    if (!dropped.length) return;
    setMsg({ text: `Uploading ${dropped.length} file(s)…`, severity: 'success' });
    let uploaded = 0;
    let failed = 0;
    let lastError = '';
    for (const { file, relPath } of dropped) {
      const path = targetDir ? `${targetDir}/${relPath}` : relPath;
      try {
        await uploadDoc(path, file);
        uploaded++;
      } catch (e) {
        failed++;
        lastError = (e as Error).message || String(e);
      }
    }
    if (failed === 0) {
      setMsg({ text: `Uploaded ${uploaded} file(s) to ${targetDir || '(root)'}`, severity: 'success' });
    } else {
      setMsg({ text: `Uploaded ${uploaded} file(s), ${failed} failed: ${lastError}`, severity: 'error' });
    }
    await refreshPath(targetDir);
  }

  /** What to drag: the whole selection if this file is part of it, else just this file. */
  function dragPathsFor(path: string): string[] {
    return selected.has(path) ? Array.from(selected) : [path];
  }

  async function onRename(path: string) {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const oldName = slash >= 0 ? path.slice(slash + 1) : path;

    const input = window.prompt('Rename file:', oldName);
    if (input == null) return;
    let next = cleanSeg(input);
    if (!next) {
      setMsg({ text: 'Name cannot be empty.', severity: 'error' });
      return;
    }
    // Keep the original extension if the user didn't type one.
    if (!/\.[^.]+$/.test(next)) {
      next += (oldName.match(/\.[^.]+$/) || [''])[0];
    }
    if (next === oldName) return;
    const newPath = dir ? `${dir}/${next}` : next;
    try {
      await moveDoc(path, newPath);
      try {
        await renameDocType(path, newPath);
      } catch {
        // Best-effort — the rename itself succeeded either way.
      }
      setMsg({ text: `Renamed to ${newPath}`, severity: 'success' });
      await refreshPath(dir);
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Rename failed', severity: 'error' });
    }
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {readOnly
          ? 'Resources shared with reps. Click the download icon to save a file.'
          : 'Resources reps see in their portal. Upload into a category (and optional subcategory).'}
      </Typography>

      {msg && (
        <Alert severity={msg.severity} sx={{ mb: 2 }} onClose={() => setMsg(null)}>
          {msg.text}
        </Alert>
      )}

      {/* ---- Upload ---- */}
      {!readOnly && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="cat-label">Category *</InputLabel>
              <Select
                labelId="cat-label"
                label="Category *"
                value={catSel}
                onChange={(e) => {
                  setCatSel(e.target.value);
                  setSubSel('');
                  setSubNew('');
                }}
              >
                <MenuItem value="">
                  <em>— Select category —</em>
                </MenuItem>
                {tree.categories.map((c) => (
                  <MenuItem key={c.name} value={c.name}>
                    {c.name}
                  </MenuItem>
                ))}
                <MenuItem value={NEW}>＋ New category…</MenuItem>
              </Select>
            </FormControl>
            {catSel === NEW && (
              <TextField
                size="small"
                label="New category name"
                value={catNew}
                onChange={(e) => setCatNew(e.target.value)}
                sx={{ minWidth: 200 }}
              />
            )}

            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="sub-label">Subcategory</InputLabel>
              <Select
                labelId="sub-label"
                label="Subcategory"
                value={subSel}
                onChange={(e) => setSubSel(e.target.value)}
              >
                <MenuItem value="">
                  <em>(none)</em>
                </MenuItem>
                {subOptions.map((s) => (
                  <MenuItem key={s} value={s}>
                    {s}
                  </MenuItem>
                ))}
                <MenuItem value={NEW}>＋ New subcategory…</MenuItem>
              </Select>
            </FormControl>
            {subSel === NEW && (
              <TextField
                size="small"
                label="New subcategory name"
                value={subNew}
                onChange={(e) => setSubNew(e.target.value)}
                sx={{ minWidth: 200 }}
              />
            )}

            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="type-label">Type</InputLabel>
              <Select
                labelId="type-label"
                label="Type"
                value={typeSel}
                onChange={(e) => setTypeSel(e.target.value as DocType)}
              >
                <MenuItem value="all">All</MenuItem>
                <MenuItem value="rep">Rep</MenuItem>
                <MenuItem value="employee">Employee</MenuItem>
              </Select>
            </FormControl>

            <Button variant="outlined" component="label" sx={{ whiteSpace: 'nowrap' }}>
              {files.length ? `${files.length} file(s)` : 'Choose files'}
              <input
                hidden
                type="file"
                accept="application/pdf"
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files || []))}
              />
            </Button>
            <Button
              variant="contained"
              startIcon={<UploadFileIcon />}
              onClick={onUpload}
              disabled={uploading}
            >
              Upload
            </Button>
          </Stack>
        </Paper>
      )}

      <Stack direction="row" alignItems="center" justifyContent="flex-end" sx={{ mb: 1 }}>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={showCounts}
              onChange={(e) => void onToggleShowCounts(e.target.checked)}
            />
          }
          label={
            <Typography variant="caption" color="text.secondary">
              Show folder counts {showCounts && loading ? '(loading…)' : ''}
            </Typography>
          }
        />
      </Stack>

      {/* ---- Tree ---- */}
      <Paper
        variant="outlined"
        sx={{ p: 1 }}
        onDragOver={readOnly ? undefined : (e) => e.preventDefault()}
        onDrop={
          readOnly
            ? undefined
            : (e) => {
                e.preventDefault();
                if (e.dataTransfer.types.includes('Files')) {
                  void readDroppedTree(e.dataTransfer).then((dropped) => onUploadDropped(dropped, ''));
                  return;
                }
                const paths = readDragPaths(e.dataTransfer);
                if (paths.length) void onMoveFiles(paths, '');
              }
        }
      >
        {loading ? (
          <Typography sx={{ p: 2 }} color="text.secondary">
            Loading…
          </Typography>
        ) : filteredTree.rootFiles.length === 0 && filteredTree.categories.length === 0 ? (
          <Typography sx={{ p: 2 }} color="text.secondary">
            {tree.rootFiles.length === 0 && tree.categories.length === 0
              ? 'No resources yet.'
              : `No ${TYPE_LABEL[typeSel].toLowerCase()} resources.`}
          </Typography>
        ) : (
          <>
            {filteredTree.rootFiles.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                depth={0}
                readOnly={readOnly}
                type={typeOf(docTypes, f.path)}
                onTypeChange={onTypeChange}
                onOpen={onOpen}
                onDownload={onDownload}
                onShare={onShare}
                onDelete={onDelete}
                onRename={onRename}
                selected={selected.has(f.path)}
                onToggleSelect={toggleSelect}
                dragPathsFor={dragPathsFor}
              />
            ))}
            {filteredTree.categories.map((c) => (
              <FolderRow
                key={c.path}
                cat={c}
                depth={0}
                open={open}
                toggle={toggle}
                onExpand={ensureFolderLoaded}
                showCounts={showCounts}
                readOnly={readOnly}
                docTypes={docTypes}
                onTypeChange={onTypeChange}
                onOpen={onOpen}
                onDownload={onDownload}
                onShare={onShare}
                onDelete={onDelete}
                onDeleteFolder={onDeleteFolder}
                onRename={onRename}
                onMoveFiles={onMoveFiles}
                onUploadDropped={onUploadDropped}
                selected={selected}
                toggleSelect={toggleSelect}
                dragPathsFor={dragPathsFor}
              />
            ))}
          </>
        )}
      </Paper>
      {!readOnly && (filteredTree.rootFiles.length > 0 || filteredTree.categories.length > 0) && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ mt: 1 }}
        >
          <Typography variant="caption" color="text.secondary">
            Check files to select several, then drag any of them onto a folder to move the whole
            selection (or onto the list background to move to the root).
          </Typography>
          {selected.size > 0 && (
            <>
              <Typography variant="caption" fontWeight={600}>
                {selected.size} selected
              </Typography>
              <Button size="small" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </>
          )}
        </Stack>
      )}

      <Menu anchorEl={shareAnchor} open={!!shareAnchor} onClose={closeShare}>
        <MenuItem onClick={onOpenInBrowser} disabled={!shareUrl}>
          <ListItemIcon>
            <IosShareIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Browser</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => void onEmailShare()} disabled={!sharePath}>
          <ListItemIcon>
            <EmailIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Email</ListItemText>
        </MenuItem>
        <MenuItem onClick={onCopyShareLink} disabled={!shareUrl}>
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy link</ListItemText>
        </MenuItem>
        <MenuItem onClick={onDownloadFromShare} disabled={!sharePath}>
          <ListItemIcon>
            <DownloadIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Download</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}

function countFiles(cat: DocCategory): number {
  return cat.files.length + cat.subs.reduce((n, s) => n + countFiles(s), 0);
}

function FolderHeader({
  name,
  count,
  isOpen,
  onClick,
  depth,
  targetDir,
  onMoveFiles,
  onUploadDropped,
  type,
  onTypeChange,
  onDeleteFolder,
}: {
  name: string;
  /** Undefined = don't know (lazy, not loaded) — hide the badge rather than show a wrong number. */
  count?: number;
  isOpen: boolean;
  onClick: () => void;
  depth: number;
  /** Full folder path (any depth) this folder represents — drop target for moves/uploads. */
  targetDir?: string;
  onMoveFiles?: (paths: string[], targetDir: string) => void;
  onUploadDropped?: (dropped: DroppedFile[], targetDir: string) => void;
  /** Omit (readOnly) to hide the rep/employee/all selector. */
  type?: DocType;
  onTypeChange?: (type: DocType) => void;
  /** Omit (readOnly) to hide the delete button. */
  onDeleteFolder?: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const canDrop = (!!onMoveFiles || !!onUploadDropped) && targetDir != null;
  return (
    <Box
      onClick={onClick}
      onDragOver={
        canDrop
          ? (e) => {
              e.preventDefault();
              setDragOver(true);
            }
          : undefined
      }
      onDragLeave={canDrop ? () => setDragOver(false) : undefined}
      onDrop={
        canDrop
          ? (e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.types.includes('Files')) {
                if (onUploadDropped) {
                  void readDroppedTree(e.dataTransfer).then((dropped) => onUploadDropped(dropped, targetDir!));
                }
                return;
              }
              const paths = readDragPaths(e.dataTransfer);
              if (paths.length) onMoveFiles?.(paths, targetDir!);
            }
          : undefined
      }
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.75,
        pl: 1 + depth * 3,
        cursor: 'pointer',
        borderRadius: 1,
        bgcolor: dragOver ? 'action.selected' : undefined,
        outline: dragOver ? '2px dashed' : 'none',
        outlineColor: 'primary.main',
        outlineOffset: '-2px',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      {isOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
      <FolderIcon fontSize="small" color="action" />
      <Typography variant="body2" fontWeight={600}>
        {name}
      </Typography>
      {count != null && (
        <Typography variant="caption" color="text.secondary">
          {count}
        </Typography>
      )}
      <Box sx={{ flex: 1 }} />
      {type != null && onTypeChange && (
        <Select
          size="small"
          variant="standard"
          value={type}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onTypeChange(e.target.value as DocType)}
          sx={{ minWidth: 90, fontSize: '0.8125rem' }}
        >
          <MenuItem value="all">All</MenuItem>
          <MenuItem value="rep">Rep</MenuItem>
          <MenuItem value="employee">Employee</MenuItem>
        </Select>
      )}
      {onDeleteFolder && (
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteFolder();
          }}
          title="Delete folder (must be empty)"
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}

/** One folder node, rendered recursively — depth is unbounded (OS drag-drop can nest folders arbitrarily deep). */
function FolderRow({
  cat,
  depth,
  open,
  toggle,
  onExpand,
  showCounts,
  readOnly,
  docTypes,
  onTypeChange,
  onOpen,
  onDownload,
  onShare,
  onDelete,
  onDeleteFolder,
  onRename,
  onMoveFiles,
  onUploadDropped,
  selected,
  toggleSelect,
  dragPathsFor,
}: {
  cat: DocCategory;
  depth: number;
  open: Record<string, boolean>;
  toggle: (key: string) => void;
  /** Fetches this folder's children the first time it's opened (no-op once loaded). */
  onExpand: (cat: DocCategory) => void | Promise<void>;
  /** Only true right after the "show counts" full load — otherwise a partially-loaded
   * subtree would show an undercount, so the badge stays hidden. */
  showCounts: boolean;
  readOnly: boolean;
  docTypes: Record<string, DocType>;
  onTypeChange: (path: string, type: DocType) => void;
  onOpen: (path: string) => void;
  onDownload: (path: string) => void;
  onShare: (path: string, anchor: HTMLElement) => void;
  onDelete: (path: string) => void;
  onDeleteFolder: (cat: DocCategory) => void;
  onRename: (path: string) => void;
  onMoveFiles: (paths: string[], targetDir: string) => void;
  onUploadDropped: (dropped: DroppedFile[], targetDir: string) => void;
  selected: Set<string>;
  toggleSelect: (path: string) => void;
  dragPathsFor: (path: string) => string[];
}) {
  const key = cat.path;
  const isOpen = !!open[key];
  return (
    <Box>
      <FolderHeader
        name={cat.name}
        count={showCounts ? countFiles(cat) : undefined}
        isOpen={isOpen}
        onClick={() => {
          if (!isOpen) void onExpand(cat);
          toggle(key);
        }}
        depth={depth}
        targetDir={readOnly ? undefined : cat.path}
        onMoveFiles={readOnly ? undefined : onMoveFiles}
        onUploadDropped={readOnly ? undefined : onUploadDropped}
        type={readOnly ? undefined : typeOf(docTypes, cat.path)}
        onTypeChange={readOnly ? undefined : (type) => onTypeChange(cat.path, type)}
        onDeleteFolder={readOnly ? undefined : () => onDeleteFolder(cat)}
      />
      <Collapse in={isOpen} unmountOnExit>
        {cat.files.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            depth={depth + 1}
            readOnly={readOnly}
            type={typeOf(docTypes, f.path)}
            onTypeChange={onTypeChange}
            onOpen={onOpen}
            onDownload={onDownload}
            onShare={onShare}
            onDelete={onDelete}
            onRename={onRename}
            selected={selected.has(f.path)}
            onToggleSelect={toggleSelect}
            dragPathsFor={dragPathsFor}
          />
        ))}
        {cat.subs.map((s) => (
          <FolderRow
            key={s.path}
            cat={s}
            depth={depth + 1}
            open={open}
            toggle={toggle}
            onExpand={onExpand}
            showCounts={showCounts}
            readOnly={readOnly}
            docTypes={docTypes}
            onTypeChange={onTypeChange}
            onOpen={onOpen}
            onDownload={onDownload}
            onShare={onShare}
            onDelete={onDelete}
            onDeleteFolder={onDeleteFolder}
            onRename={onRename}
            onMoveFiles={onMoveFiles}
            onUploadDropped={onUploadDropped}
            selected={selected}
            toggleSelect={toggleSelect}
            dragPathsFor={dragPathsFor}
          />
        ))}
      </Collapse>
    </Box>
  );
}

function FileRow({
  file,
  depth,
  readOnly,
  type,
  onTypeChange,
  onOpen,
  onDownload,
  onShare,
  onDelete,
  onRename,
  selected,
  onToggleSelect,
  dragPathsFor,
}: {
  file: DocFile;
  depth: number;
  readOnly: boolean;
  type: DocType;
  onTypeChange: (path: string, type: DocType) => void;
  onOpen: (path: string) => void;
  onDownload: (path: string) => void;
  onShare: (path: string, anchor: HTMLElement) => void;
  onDelete: (path: string) => void;
  onRename: (path: string) => void;
  selected?: boolean;
  onToggleSelect?: (path: string) => void;
  dragPathsFor?: (path: string) => string[];
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <Box
      draggable={!readOnly}
      onDragStart={
        readOnly
          ? undefined
          : (e) => {
              const paths = dragPathsFor ? dragPathsFor(file.path) : [file.path];
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
              e.dataTransfer.setData('text/plain', file.path);
              e.dataTransfer.effectAllowed = 'move';
              setDragging(true);
            }
      }
      onDragEnd={readOnly ? undefined : () => setDragging(false)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.5,
        pl: 1 + depth * 3 + 3,
        opacity: dragging ? 0.5 : 1,
        cursor: readOnly ? 'default' : 'grab',
        bgcolor: selected ? 'action.selected' : undefined,
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
      }}
    >
      {!readOnly && (
        <Checkbox
          size="small"
          checked={!!selected}
          onChange={() => onToggleSelect?.(file.path)}
          onClick={(e) => e.stopPropagation()}
          sx={{ p: 0.5 }}
        />
      )}
      <DescriptionIcon fontSize="small" color="action" />
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
        {file.name}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
        {fmtSize(file.size)}
      </Typography>
      {readOnly ? null : (
        <Select
          size="small"
          variant="standard"
          value={type}
          onChange={(e) => onTypeChange(file.path, e.target.value as DocType)}
          sx={{ mr: 1, minWidth: 90, fontSize: '0.8125rem' }}
        >
          <MenuItem value="all">All</MenuItem>
          <MenuItem value="rep">Rep</MenuItem>
          <MenuItem value="employee">Employee</MenuItem>
        </Select>
      )}
      <IconButton size="small" onClick={() => onOpen(file.path)} title="Open">
        <OpenInNewIcon fontSize="small" />
      </IconButton>
      <IconButton size="small" onClick={() => onDownload(file.path)} title="Download">
        <DownloadIcon fontSize="small" />
      </IconButton>
      <IconButton
        size="small"
        onClick={(e) => onShare(file.path, e.currentTarget)}
        title="Share"
      >
        <ShareIcon fontSize="small" />
      </IconButton>
      {!readOnly && (
        <>
          <IconButton size="small" onClick={() => onRename(file.path)} title="Rename">
            <DriveFileRenameOutlineIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" onClick={() => onDelete(file.path)} title="Delete">
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </>
      )}
    </Box>
  );
}
