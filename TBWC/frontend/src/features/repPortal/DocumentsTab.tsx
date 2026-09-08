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
  Collapse,
  FormControl,
  IconButton,
  InputLabel,
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
      <Paper variant="outlined" sx={{ p: 1 }}>
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
                onDelete={onDelete}
                onRename={onRename}
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
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </>
        )}
      </Paper>
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
}: {
  name: string;
  count: number;
  isOpen: boolean;
  onClick: () => void;
  depth: number;
}) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.75,
        pl: 1 + depth * 3,
        cursor: 'pointer',
        borderRadius: 1,
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
  onDelete,
  onRename,
}: {
  cat: DocCategory;
  open: Record<string, boolean>;
  toggle: (key: string) => void;
  readOnly: boolean;
  docTypes: Record<string, DocType>;
  onTypeChange: (path: string, type: DocType) => void;
  onOpen: (path: string) => void;
  onDownload: (path: string) => void;
  onDelete: (path: string) => void;
  onRename: (path: string) => void;
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
            onDelete={onDelete}
            onRename={onRename}
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
                    onDelete={onDelete}
                    onRename={onRename}
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
  onDelete,
  onRename,
}: {
  file: DocFile;
  depth: number;
  readOnly: boolean;
  type: DocType;
  onTypeChange: (path: string, type: DocType) => void;
  onOpen: (path: string) => void;
  onDownload: (path: string) => void;
  onDelete: (path: string) => void;
  onRename: (path: string) => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.5,
        pl: 1 + depth * 3 + 3,
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
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
