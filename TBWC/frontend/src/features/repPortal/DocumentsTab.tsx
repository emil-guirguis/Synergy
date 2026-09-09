/**
 * Documents tab — admin document manager.
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
  Divider,
  FormControl,
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
import FacebookIcon from '@mui/icons-material/Facebook';
import TwitterIcon from '@mui/icons-material/Twitter';
import LinkedInIcon from '@mui/icons-material/LinkedIn';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import EmailIcon from '@mui/icons-material/Email';
import {
  listDocsTree,
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

/** Files with no row in rep_doc_type default to 'all' (visible to everyone). */
function typeOf(docTypes: Record<string, DocType>, path: string): DocType {
  return docTypes[path] ?? 'all';
}

/** Drop files that don't match `typeSel` ('all' = no filtering); prune emptied folders. */
function filterTree(tree: DocTree, docTypes: Record<string, DocType>, typeSel: DocType): DocTree {
  if (typeSel === 'all') return tree;
  const keep = (f: DocFile) => {
    const t = typeOf(docTypes, f.path);
    return t === 'all' || t === typeSel;
  };
  const rootFiles = tree.rootFiles.filter(keep);
  const categories = tree.categories
    .map((c) => {
      const files = c.files.filter(keep);
      const subs = c.subs.map((s) => ({ ...s, files: s.files.filter(keep) })).filter((s) => s.files.length > 0);
      return { ...c, files, subs };
    })
    .filter((c) => c.files.length > 0 || c.subs.length > 0);
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

/** Files currently listed directly under `dir` ("" = bucket root). */
function filesAt(tree: DocTree, dir: string): DocFile[] {
  if (!dir) return tree.rootFiles;
  const [catName, subName] = dir.split('/');
  const cat = tree.categories.find((c) => c.name === catName);
  if (!cat) return [];
  if (!subName) return cat.files;
  return cat.subs.find((s) => s.name === subName)?.files ?? [];
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

export default function DocumentsTab({ readOnly = false }: { readOnly?: boolean }) {
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, dt] = await Promise.all([listDocsTree(), getDocTypes().catch(() => ({}))]);
      setTree(t);
      setDocTypes(dt);
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Could not load documents', severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  // Reps only ever see 'all' + 'rep' docs — 'employee' stays hidden regardless of typeSel.
  const filteredTree = useMemo(() => {
    if (readOnly) {
      const keep = (f: DocFile) => typeOf(docTypes, f.path) !== 'employee';
      const rootFiles = tree.rootFiles.filter(keep);
      const categories = tree.categories
        .map((c) => {
          const files = c.files.filter(keep);
          const subs = c.subs.map((s) => ({ ...s, files: s.files.filter(keep) })).filter((s) => s.files.length > 0);
          return { ...c, files, subs };
        })
        .filter((c) => c.files.length > 0 || c.subs.length > 0);
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

  // Subcategory options depend on the chosen (existing) category.
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
      await load();
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
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Delete failed', severity: 'error' });
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
      setMsg({ text: (e as Error).message || 'Could not open document', severity: 'error' });
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
      await navigator.clipboard.writeText(shareUrl);
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

  function onSocialShare(network: 'facebook' | 'twitter' | 'linkedin' | 'whatsapp' | 'email') {
    if (!shareUrl) return;
    const encodedUrl = encodeURIComponent(shareUrl);
    const name = sharePath ? sharePath.split('/').pop() || '' : '';
    const text = encodeURIComponent(name);
    const links: Record<typeof network, string> = {
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
      twitter: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${text}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
      whatsapp: `https://wa.me/?text=${text}%20${encodedUrl}`,
      email: `mailto:?subject=${text}&body=${encodedUrl}`,
    };
    if (network === 'email') {
      window.location.href = links.email;
    } else {
      window.open(links[network], '_blank', 'noopener,noreferrer,width=600,height=500');
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
    await load();
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
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Rename failed', severity: 'error' });
    }
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {readOnly
          ? 'Documents shared with reps. Click the download icon to save a file.'
          : 'Documents reps see in their portal. Upload into a category (and optional subcategory).'}
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
              ? 'No documents yet.'
              : `No ${TYPE_LABEL[typeSel].toLowerCase()} documents.`}
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
              <CategoryRow
                key={c.name}
                cat={c}
                open={open}
                toggle={toggle}
                readOnly={readOnly}
                docTypes={docTypes}
                onTypeChange={onTypeChange}
                onOpen={onOpen}
                onDownload={onDownload}
                onShare={onShare}
                onDelete={onDelete}
                onRename={onRename}
                onMoveFiles={onMoveFiles}
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
        <MenuItem onClick={() => onSocialShare('email')} disabled={!shareUrl}>
          <ListItemIcon>
            <EmailIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Email</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => onSocialShare('facebook')} disabled={!shareUrl}>
          <ListItemIcon>
            <FacebookIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Facebook</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => onSocialShare('twitter')} disabled={!shareUrl}>
          <ListItemIcon>
            <TwitterIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Twitter / X</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => onSocialShare('linkedin')} disabled={!shareUrl}>
          <ListItemIcon>
            <LinkedInIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>LinkedIn</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => onSocialShare('whatsapp')} disabled={!shareUrl}>
          <ListItemIcon>
            <WhatsAppIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>WhatsApp</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={onCopyShareLink} disabled={!shareUrl}>
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy link</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}

function countFiles(cat: DocCategory): number {
  return cat.files.length + cat.subs.reduce((n, s) => n + s.files.length, 0);
}

function FolderHeader({
  name,
  count,
  isOpen,
  onClick,
  depth,
  targetDir,
  onMoveFiles,
}: {
  name: string;
  count: number;
  isOpen: boolean;
  onClick: () => void;
  depth: number;
  /** Full category (or category/sub) path this folder represents — drop target for moves. */
  targetDir?: string;
  onMoveFiles?: (paths: string[], targetDir: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const canDrop = !!onMoveFiles && targetDir != null;
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
              const paths = readDragPaths(e.dataTransfer);
              if (paths.length) onMoveFiles!(paths, targetDir!);
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
      <Typography variant="caption" color="text.secondary">
        {count}
      </Typography>
    </Box>
  );
}

function CategoryRow({
  cat,
  open,
  toggle,
  readOnly,
  docTypes,
  onTypeChange,
  onOpen,
  onDownload,
  onShare,
  onDelete,
  onRename,
  onMoveFiles,
  selected,
  toggleSelect,
  dragPathsFor,
}: {
  cat: DocCategory;
  open: Record<string, boolean>;
  toggle: (key: string) => void;
  readOnly: boolean;
  docTypes: Record<string, DocType>;
  onTypeChange: (path: string, type: DocType) => void;
  onOpen: (path: string) => void;
  onDownload: (path: string) => void;
  onShare: (path: string, anchor: HTMLElement) => void;
  onDelete: (path: string) => void;
  onRename: (path: string) => void;
  onMoveFiles: (paths: string[], targetDir: string) => void;
  selected: Set<string>;
  toggleSelect: (path: string) => void;
  dragPathsFor: (path: string) => string[];
}) {
  const key = cat.name;
  const isOpen = !!open[key];
  return (
    <Box>
      <FolderHeader
        name={cat.name}
        count={countFiles(cat)}
        isOpen={isOpen}
        onClick={() => toggle(key)}
        depth={0}
        targetDir={readOnly ? undefined : cat.name}
        onMoveFiles={readOnly ? undefined : onMoveFiles}
      />
      <Collapse in={isOpen} unmountOnExit>
        {cat.files.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            depth={1}
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
        {cat.subs.map((s) => {
          const subKey = `${cat.name}/${s.name}`;
          const subOpen = !!open[subKey];
          return (
            <Box key={subKey}>
              <FolderHeader
                name={s.name}
                count={s.files.length}
                isOpen={subOpen}
                onClick={() => toggle(subKey)}
                depth={1}
                targetDir={readOnly ? undefined : subKey}
                onMoveFiles={readOnly ? undefined : onMoveFiles}
              />
              <Collapse in={subOpen} unmountOnExit>
                {s.files.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    depth={2}
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
              </Collapse>
            </Box>
          );
        })}
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
