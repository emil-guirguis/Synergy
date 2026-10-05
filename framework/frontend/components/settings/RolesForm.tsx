import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, Collapse, Divider, IconButton, List, ListItemButton,
  ListItemText, MenuItem, Paper, Select, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FolderIcon from '@mui/icons-material/Folder';
import TuneIcon from '@mui/icons-material/Tune';
import { loadSchema, type ConvertedSchema } from '../form/utils/schemaLoader';
import './SettingsForm.css';

export type GrantScope = 'all' | 'own';

/** Per-field view/edit override. Omitted = both true (full access, the default). */
export interface FieldAccess {
  view?: boolean;
  edit?: boolean;
}

export interface RoleGrant {
  permission: string;
  scope: GrantScope;
  hidden_fields: string[];
  /** Keyed by field name (`sold_for`) or, one level into a jsonb array
   *  column, `column[].field` (`lines[].rate`) — same addressing as
   *  hidden_fields. See the field-security grid in renderModuleNode. */
  field_access: Record<string, FieldAccess>;
}

export interface ManagedRole {
  role_id: number;
  code: string;
  name: string;
  is_system: boolean;
  user_count: number;
  grants: RoleGrant[];
}

export interface RoleGroup {
  label: string;
  /** Catalog modules nested under this group, e.g. Utilities > Notifications. */
  modules: (string | RoleModuleLabel)[];
}

/** A single module with a display label that isn't just titleCase(module) — e.g. {module: 'resource', label: 'Resources'}. */
export interface RoleModuleLabel {
  module: string;
  label: string;
}

/** A top-level tree position: a bare module name, a labeled module, or a nested group. */
export type RoleTreeNode = string | RoleModuleLabel | RoleGroup;

export interface RolesFormProps {
  roles: ManagedRole[];
  /** The permission strings this app's routes enforce. */
  catalog: string[];
  /** Optional — the app's nav order (e.g. ['dashboard', {label: 'Utilities',
   * modules: ['notification']}, 'settings']) so the tree reads top-to-bottom
   * the same as the sidebar. A catalog module not mentioned here is appended
   * at the end, in catalog order. */
  order?: RoleTreeNode[];
  onCreate: (input: { code: string; name: string }) => Promise<void> | void;
  onRename: (roleId: number, name: string) => Promise<void> | void;
  onSaveGrants: (roleId: number, grants: RoleGrant[]) => Promise<void> | void;
  onDelete: (roleId: number) => Promise<void> | void;
  loading?: boolean;
  error?: string | null;
}

const moduleOf = (permission: string) => permission.split(':')[0];
const actionOf = (permission: string) => permission.split(':').slice(1).join(':');
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Settings > Roles: pick a role, tick what it may do. Shared by every app —
 * each one passes its own permission catalog and its own API callbacks, the
 * same way the other settings forms take values and handlers.
 *
 * Deliberately grid-shaped rather than a per-permission form: the question
 * being answered is "what can this role do", and that only reads well when
 * every permission is visible at once, including the unticked ones.
 */
const RolesForm: React.FC<RolesFormProps> = ({
  roles, catalog, order = [], onCreate, onRename, onSaveGrants, onDelete, loading, error,
}) => {
  const [selectedId, setSelectedId] = useState<number | null>(roles[0]?.role_id ?? null);
  const [draft, setDraft] = useState<Map<string, RoleGrant>>(new Map());
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ code: '', name: '' });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggleNode = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  // Field-security grid: lazily fetched per module (same schema the module's
  // own form/list render from), keyed by module name. null = fetched, no
  // schema for this module (e.g. resource/notification have no entity form)
  // — rendered as "no fields", not an error, since plenty of catalog modules
  // are permission-only.
  const [fieldSchemas, setFieldSchemas] = useState<Record<string, ConvertedSchema | null>>({});
  const [loadingSchemas, setLoadingSchemas] = useState<Record<string, boolean>>({});
  const ensureFieldSchema = (module: string) => {
    if (module in fieldSchemas || loadingSchemas[module]) return;
    setLoadingSchemas((s) => ({ ...s, [module]: true }));
    loadSchema(module)
      .then((schema) => setFieldSchemas((s) => ({ ...s, [module]: schema })))
      .catch(() => setFieldSchemas((s) => ({ ...s, [module]: null })))
      .finally(() => setLoadingSchemas((s) => ({ ...s, [module]: false })));
  };

  const selected = roles.find((r) => r.role_id === selectedId) ?? null;

  // Re-seed the working copy whenever the selection changes or the server sends
  // a fresh list, so an edit never carries over onto a different role.
  useEffect(() => {
    setDraft(new Map((selected?.grants ?? []).map((g) => [g.permission, g])));
    setName(selected?.name ?? '');
    setOpen({});
  }, [selected]);

  useEffect(() => {
    if (selectedId === null && roles.length) setSelectedId(roles[0].role_id);
  }, [roles, selectedId]);

  const byModule = useMemo(() => {
    const byModuleMap = new Map<string, string[]>();
    for (const p of catalog) {
      const m = moduleOf(p);
      if (!byModuleMap.has(m)) byModuleMap.set(m, []);
      byModuleMap.get(m)!.push(p);
    }
    return [...byModuleMap.entries()];
  }, [catalog]);

  // Every module's header count includes its fields (see renderModuleNode),
  // so every module's schema has to be known up front — not lazily on first
  // expand, the way the Fields section's own content still is.
  useEffect(() => {
    for (const [module] of byModule) ensureFieldSchema(module);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byModule]);

  // Walk `order` to build the top-level list in exactly the nav's sequence —
  // a bare module renders in place, a group nests its modules underneath
  // (e.g. Utilities > Notifications). Anything in the catalog that `order`
  // doesn't mention (new permission, or an app that passes no `order` at
  // all) is appended at the end in catalog order, so nothing is ever lost.
  const tree = useMemo(() => {
    const permsByModule = new Map(byModule);
    const used = new Set<string>();

    const topNodes: (
      | { kind: 'module'; module: string; label?: string; permissions: string[] }
      | { kind: 'group'; label: string; modules: [string, string[], string?][] }
    )[] = [];

    for (const item of order) {
      if (typeof item === 'string' || 'module' in item) {
        const module = typeof item === 'string' ? item : item.module;
        const label = typeof item === 'string' ? undefined : item.label;
        const permissions = permsByModule.get(module);
        if (!permissions || used.has(module)) continue;
        used.add(module);
        topNodes.push({ kind: 'module', module, label, permissions });
      } else {
        const modules: [string, string[], string?][] = [];
        for (const m of item.modules) {
          const module = typeof m === 'string' ? m : m.module;
          const label = typeof m === 'string' ? undefined : m.label;
          const permissions = permsByModule.get(module);
          if (!permissions || used.has(module)) continue;
          used.add(module);
          modules.push([module, permissions, label]);
        }
        if (modules.length) topNodes.push({ kind: 'group', label: item.label, modules });
      }
    }

    for (const entry of byModule) {
      const [module] = entry;
      if (!used.has(module)) topNodes.push({ kind: 'module', module, permissions: entry[1] });
    }

    return topNodes;
  }, [byModule, order]);

  const dirty = useMemo(() => {
    if (!selected) return false;
    const original = new Map(selected.grants.map((g) => [g.permission, g]));
    if (original.size !== draft.size) return true;
    for (const [permission, g] of draft) {
      const o = original.get(permission);
      if (
        !o ||
        o.scope !== g.scope ||
        o.hidden_fields.join(',') !== g.hidden_fields.join(',') ||
        JSON.stringify(o.field_access ?? {}) !== JSON.stringify(g.field_access ?? {})
      ) {
        return true;
      }
    }
    return false;
  }, [selected, draft]);

  const toggle = (permission: string) => {
    setDraft((prev) => {
      const next = new Map(prev);
      if (next.has(permission)) next.delete(permission);
      else next.set(permission, { permission, scope: 'all', hidden_fields: [], field_access: {} });
      return next;
    });
  };

  const patch = (permission: string, changes: Partial<RoleGrant>) => {
    setDraft((prev) => {
      const current = prev.get(permission);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(permission, { ...current, ...changes });
      return next;
    });
  };

  /** Flip one field's view/edit bit on a permission's field_access, pruning
   *  the entry back to nothing once both bits are back to "allowed" (true/
   *  unset) so an untouched field never shows up as a no-op diff. */
  const patchFieldAccess = (permission: string, field: string, bit: 'view' | 'edit', value: boolean) => {
    setDraft((prev) => {
      const current = prev.get(permission);
      if (!current) return prev;
      const fieldAccess = { ...current.field_access };
      const entry: FieldAccess = { ...fieldAccess[field], [bit]: value };
      if (entry[bit] !== false) delete entry[bit];
      if (Object.keys(entry).length === 0) delete fieldAccess[field];
      else fieldAccess[field] = entry;
      const next = new Map(prev);
      next.set(permission, { ...current, field_access: fieldAccess });
      return next;
    });
  };

  const renderPermissionRow = (permission: string, depth: number) => {
    const grant = draft.get(permission);
    return (
      <Box
        key={permission}
        sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.25, pl: 4 + depth * 3 }}
      >
        <Checkbox
          size="small" checked={!!grant} disabled={loading}
          onChange={() => toggle(permission)}
        />
        <Typography variant="body2" sx={{ width: 110 }}>{titleCase(actionOf(permission))}</Typography>
        <Select
          size="small" value={grant?.scope ?? 'all'} disabled={!grant || loading}
          sx={{ width: 130 }}
          onChange={(e) => patch(permission, { scope: e.target.value as GrantScope })}
        >
          <MenuItem value="all">All records</MenuItem>
          <MenuItem value="own">Own records</MenuItem>
        </Select>
        <TextField
          size="small" placeholder="Hidden fields (comma separated)"
          sx={{ flex: 1 }} disabled={!grant || loading}
          value={grant?.hidden_fields.join(', ') ?? ''}
          onChange={(e) =>
            patch(permission, {
              hidden_fields: e.target.value.split(',').map((f) => f.trim()).filter(Boolean),
            })
          }
        />
      </Box>
    );
  };

  /** One field (or one grid column, addressed as `column[].field`): a label
   *  plus View/Edit checkboxes against the module's read/write grants. */
  // Both the header labels and every row's checkboxes sit in a column this
  // wide, centered, so "View"/"Edit" lines up with the box under it — the
  // only thing that told the two checkboxes apart before was a hover
  // tooltip, easy to miss with no visible header at all.
  const FIELD_CHECKBOX_COL = 56;

  const renderFieldRow = (fieldKey: string, label: string, readPerm: string, writePerm: string | undefined, depth: number) => {
    const readGrant = draft.get(readPerm);
    const writeGrant = writePerm ? draft.get(writePerm) : undefined;
    const viewChecked = readGrant?.field_access[fieldKey]?.view !== false;
    const editChecked = writeGrant?.field_access[fieldKey]?.edit !== false;
    return (
      <Box key={fieldKey} sx={{ display: 'flex', alignItems: 'center', py: 0.125, pl: 6 + depth * 3 }}>
        <Typography variant="body2" sx={{ flex: 1, color: 'text.secondary' }}>{label}</Typography>
        <Box sx={{ width: FIELD_CHECKBOX_COL, display: 'flex', justifyContent: 'center' }}>
          <Tooltip title="Visible — shows up on the list/form at all">
            <Checkbox
              size="small" checked={viewChecked} disabled={loading}
              onChange={(e) => patchFieldAccess(readPerm, fieldKey, 'view', e.target.checked)}
            />
          </Tooltip>
        </Box>
        <Box sx={{ width: FIELD_CHECKBOX_COL, display: 'flex', justifyContent: 'center' }}>
          <Tooltip title="Editable — can be changed, not just viewed">
            <Checkbox
              size="small" checked={editChecked} disabled={loading || !writeGrant}
              onChange={(e) => writePerm && patchFieldAccess(writePerm, fieldKey, 'edit', e.target.checked)}
            />
          </Tooltip>
        </Box>
      </Box>
    );
  };

  const renderFieldsHeaderRow = (depth: number, opts: { editColumn?: boolean } = {}) => (
    <Box sx={{ display: 'flex', alignItems: 'center', pl: 6 + depth * 3, pb: 0.25 }}>
      <Box sx={{ flex: 1 }} />
      <Typography variant="caption" sx={{ width: FIELD_CHECKBOX_COL, textAlign: 'center', fontWeight: 600 }}>
        View
      </Typography>
      {opts.editColumn !== false && (
        <Typography variant="caption" sx={{ width: FIELD_CHECKBOX_COL, textAlign: 'center', fontWeight: 600 }}>
          Edit
        </Typography>
      )}
    </Box>
  );

  /** One list column: just a View checkbox — a list is read-only, nothing
   *  in it is independently editable, so there's no Edit bit to show. Same
   *  field_access entry as the same field's row under Form, by design: one
   *  caller may not see a field on the list but see it on the form (a wide
   *  column not worth a spot in the grid), but "hidden" has to mean the
   *  same thing everywhere redactRow() strips it server-side. */
  const renderListColumnRow = (fieldKey: string, label: string, readPerm: string, depth: number) => {
    const readGrant = draft.get(readPerm);
    const viewChecked = readGrant?.field_access[fieldKey]?.view !== false;
    return (
      <Box key={fieldKey} sx={{ display: 'flex', alignItems: 'center', py: 0.125, pl: 6 + depth * 3 }}>
        <Typography variant="body2" sx={{ flex: 1, color: 'text.secondary' }}>{label}</Typography>
        <Box sx={{ width: FIELD_CHECKBOX_COL, display: 'flex', justifyContent: 'center' }}>
          <Tooltip title="Shown as a column on the list">
            <Checkbox
              size="small" checked={viewChecked} disabled={loading}
              onChange={(e) => patchFieldAccess(readPerm, fieldKey, 'view', e.target.checked)}
            />
          </Tooltip>
        </Box>
      </Box>
    );
  };

  /** List: the module's own read/write/delete grants (moved here from
   *  directly under the module — they govern what the list screen can do),
   *  plus every column the schema marks showOn: ['list']. */
  const renderListSection = (module: string, permissions: string[], readPerm: string | undefined, depth: number) => {
    const key = `list:${module}`;
    const isOpen = !!open[key];
    const schema = fieldSchemas[module];
    const listFields = schema
      ? Object.entries(schema.formFields).filter(([, def]) => def.showOn?.includes('list'))
      : [];
    return (
      <Box key={key} sx={{ mb: 0.5 }}>
        <Box
          onClick={() => {
            toggleNode(key);
            if (readPerm) ensureFieldSchema(module);
          }}
          sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            py: 0.5, pl: 3 + depth * 3, cursor: 'pointer', borderRadius: 1,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          {isOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
          <TuneIcon fontSize="small" color="action" />
          <Typography variant="body2" color="text.secondary">List</Typography>
          <Typography variant="caption" color="text.secondary">
            {permissions.filter((p) => draft.has(p)).length}/{permissions.length}
          </Typography>
        </Box>
        <Collapse in={isOpen} unmountOnExit>
          {permissions.map((permission) => renderPermissionRow(permission, depth + 1))}
          {readPerm && listFields.length > 0 && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pl: 6 + depth * 3, pt: 0.5 }}>
                Columns
              </Typography>
              {renderFieldsHeaderRow(depth, { editColumn: false })}
              {listFields.map(([name, def]) =>
                renderListColumnRow(name, def.label || titleCase(name), readPerm, depth + 1)
              )}
            </>
          )}
        </Collapse>
      </Box>
    );
  };

  /** Form: the module's own form schema, flattened to one row per field —
   *  grouped by the form's own tabs when it has any (findable the same way
   *  the form itself reads), grid-type fields (gridColumns) expanding into
   *  one row per column instead of one row for the whole field. */
  const renderFormSection = (module: string, readPerm: string, writePerm: string | undefined, depth: number) => {
    const key = `form:${module}`;
    const isOpen = !!open[key];
    const schema = fieldSchemas[module];
    const readGrant = draft.get(readPerm);
    const { granted: fieldsGranted, total: fieldsTotal } = fieldCounts(module, readPerm, writePerm);

    const fieldRows = (fieldNames: string[], subDepth: number) =>
      fieldNames.map((name) => {
        const def = schema?.formFields[name];
        if (!def) return null;
        const label = def.label || titleCase(name);
        const gridColumns = (def as any).gridColumns as { key: string; label: string }[] | undefined;
        if (gridColumns?.length) {
          return (
            <Box key={name}>
              <Box sx={{ pl: 6 + subDepth * 3, py: 0.125 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary' }}>{label}</Typography>
              </Box>
              {gridColumns.map((col) =>
                renderFieldRow(`${name}[].${col.key}`, col.label, readPerm, writePerm, subDepth + 1)
              )}
            </Box>
          );
        }
        return renderFieldRow(name, label, readPerm, writePerm, subDepth);
      });

    return (
      <Box key={key} sx={{ mb: 0.5 }}>
        <Box
          onClick={() => {
            toggleNode(key);
            ensureFieldSchema(module);
          }}
          sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            py: 0.5, pl: 3 + depth * 3, cursor: 'pointer', borderRadius: 1,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          {isOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
          <TuneIcon fontSize="small" color="action" />
          <Typography variant="body2" color="text.secondary">Form</Typography>
          {fieldsTotal > 0 && (
            <Typography variant="caption" color="text.secondary">
              {fieldsGranted}/{fieldsTotal}
            </Typography>
          )}
        </Box>
        <Collapse in={isOpen} unmountOnExit>
          {!readGrant ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pl: 6 + depth * 3, py: 0.5 }}>
              Grant Read first.
            </Typography>
          ) : loadingSchemas[module] ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pl: 6 + depth * 3, py: 0.5 }}>
              Loading…
            </Typography>
          ) : !schema || !Object.keys(schema.formFields).length ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pl: 6 + depth * 3, py: 0.5 }}>
              No configurable fields for this module.
            </Typography>
          ) : (
            <>
              {renderFieldsHeaderRow(depth)}
              {schema.formTabs?.length ? (
                schema.formTabs
                  .slice()
                  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                  .map((tab) => {
                    const names = [...new Set(tab.sections.flatMap((s) => s.fields.map((f) => f.name)))]
                      .filter((n) => schema.formFields[n]);
                    if (!names.length) return null;
                    // Addressed in field_access the same way a grid column is
                    // (tab:Name instead of column[].field) — a tab has no
                    // edit concept of its own, so just the one checkbox.
                    // Consuming code passes this through to BaseForm's own
                    // `hiddenTabs` prop (see OrderForm.tsx for the pattern).
                    const tabKey = `tab:${tab.name}`;
                    const tabVisible = readGrant?.field_access[tabKey]?.view !== false;
                    return (
                      <Box key={tab.name} sx={{ pl: 3 + depth * 3, py: 0.25 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          <Checkbox
                            size="small" checked={tabVisible} disabled={loading}
                            onChange={(e) => patchFieldAccess(readPerm, tabKey, 'view', e.target.checked)}
                          />
                          <Typography variant="caption" sx={{ fontWeight: 600 }}>{tab.name}</Typography>
                        </Box>
                        {tabVisible && fieldRows(names, depth + 1)}
                      </Box>
                    );
                  })
              ) : (
                fieldRows(Object.keys(schema.formFields), depth + 1)
              )}
            </>
          )}
        </Collapse>
      </Box>
    );
  };

  /** Every field (or grid column, `column[].field`) this module's schema
   *  carries — the same units renderFormSection shows a row per. */
  const fieldUnitsOf = (module: string): string[] => {
    const schema = fieldSchemas[module];
    if (!schema) return [];
    const units: string[] = [];
    for (const [name, def] of Object.entries(schema.formFields)) {
      const gridColumns = (def as any).gridColumns as { key: string }[] | undefined;
      if (gridColumns?.length) units.push(...gridColumns.map((c) => `${name}[].${c.key}`));
      else units.push(name);
    }
    return units;
  };

  /** A module's fields (or grid columns), granted vs total: a field counts
   *  as granted only while Read is held and neither its view nor edit bit
   *  has been turned off. Shared by the module header's count and the
   *  Fields row's own count below it. */
  const fieldCounts = (module: string, readPerm: string | undefined, writePerm: string | undefined) => {
    const units = readPerm ? fieldUnitsOf(module) : [];
    const readGrant = readPerm ? draft.get(readPerm) : undefined;
    const writeGrant = writePerm ? draft.get(writePerm) : undefined;
    const granted = readGrant
      ? units.filter((u) => {
          const viewOk = readGrant.field_access[u]?.view !== false;
          const editOk = !writeGrant || writeGrant.field_access[u]?.edit !== false;
          return viewOk && editOk;
        }).length
      : 0;
    return { granted, total: units.length };
  };

  /** A module's header count, folding its fields in alongside its actions. */
  const moduleCounts = (permissions: string[]) => {
    const readPerm = permissions.find((p) => actionOf(p) === 'read');
    const writePerm = permissions.find((p) => actionOf(p) === 'write');
    const fields = readPerm ? fieldCounts(moduleOf(readPerm), readPerm, writePerm) : { granted: 0, total: 0 };
    return {
      granted: permissions.filter((p) => draft.has(p)).length + fields.granted,
      total: permissions.length + fields.total,
    };
  };

  const renderModuleNode = (module: string, permissions: string[], depth: number, label?: string) => {
    const key = `module:${module}`;
    const isOpen = !!open[key];
    const { granted: grantedCount, total: totalCount } = moduleCounts(permissions);
    const readPerm = permissions.find((p) => actionOf(p) === 'read');
    const writePerm = permissions.find((p) => actionOf(p) === 'write');
    return (
      <Box key={key} sx={{ mb: 0.5 }}>
        <Box
          onClick={() => toggleNode(key)}
          sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            py: 0.75, pl: depth * 3, cursor: 'pointer', borderRadius: 1,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          {isOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
          <FolderIcon fontSize="small" color="action" />
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{label ?? titleCase(module)}</Typography>
          <Typography variant="caption" color="text.secondary">
            {grantedCount}/{totalCount}
          </Typography>
        </Box>
        <Divider />
        <Collapse in={isOpen} unmountOnExit>
          {renderListSection(module, permissions, readPerm, depth)}
          {readPerm && renderFormSection(module, readPerm, writePerm, depth)}
        </Collapse>
      </Box>
    );
  };

  const renderGroupNode = (label: string, modules: [string, string[], string?][]) => {
    const key = `group:${label}`;
    const isOpen = !!open[key];
    const grantedCount = modules.reduce((n, [, perms]) => n + moduleCounts(perms).granted, 0);
    const totalCount = modules.reduce((n, [, perms]) => n + moduleCounts(perms).total, 0);
    return (
      <Box key={key} sx={{ mb: 0.5 }}>
        <Box
          onClick={() => toggleNode(key)}
          sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            py: 0.75, cursor: 'pointer', borderRadius: 1,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          {isOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
          <FolderIcon fontSize="small" color="action" />
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{label}</Typography>
          <Typography variant="caption" color="text.secondary">
            {grantedCount}/{totalCount}
          </Typography>
        </Box>
        <Divider />
        <Collapse in={isOpen} unmountOnExit>
          {modules.map(([module, permissions, moduleLabel]) => renderModuleNode(module, permissions, 1, moduleLabel))}
        </Collapse>
      </Box>
    );
  };

  return (
    <Box className="settings-form">
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, alignItems: { xs: 'stretch', md: 'flex-start' } }}>
        <Paper variant="outlined" sx={{ width: { xs: '100%', md: 240 }, flexShrink: 0 }}>
          <List disablePadding>
            {roles.map((role) => (
              <ListItemButton
                key={role.role_id}
                selected={role.role_id === selectedId}
                onClick={() => setSelectedId(role.role_id)}
              >
                <ListItemText
                  primary={role.name}
                  secondary={`${role.user_count} user${role.user_count === 1 ? '' : 's'}`}
                />
                {role.is_system && <Chip label="Built-in" size="small" variant="outlined" />}
              </ListItemButton>
            ))}
          </List>
          <Divider />
          {creating ? (
            <Box sx={{ p: 1.5, display: 'grid', gap: 1 }}>
              <TextField
                size="small" label="Name" value={newRole.name}
                onChange={(e) => setNewRole((r) => ({ ...r, name: e.target.value }))}
              />
              <TextField
                size="small" label="Code" value={newRole.code} placeholder="senior_rep"
                helperText="Lowercase, no spaces"
                onChange={(e) => setNewRole((r) => ({ ...r, code: e.target.value }))}
              />
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  size="small" variant="contained" disabled={loading || !newRole.code || !newRole.name}
                  onClick={async () => {
                    await onCreate(newRole);
                    setNewRole({ code: '', name: '' });
                    setCreating(false);
                  }}
                >
                  Create
                </Button>
                <Button size="small" onClick={() => setCreating(false)}>Cancel</Button>
              </Box>
            </Box>
          ) : (
            <Button fullWidth startIcon={<AddIcon />} onClick={() => setCreating(true)} disabled={loading}>
              New role
            </Button>
          )}
        </Paper>

        {selected && (
          <Paper variant="outlined" sx={{ flex: 1, p: 2 }}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
              <TextField
                size="small" label="Role name" value={name} disabled={loading}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => { if (name.trim() && name !== selected.name) onRename(selected.role_id, name.trim()); }}
              />
              <Chip label={selected.code} size="small" variant="outlined" />
              <Box sx={{ flex: 1 }} />
              {!selected.is_system && (
                <Tooltip title={selected.user_count > 0 ? 'Reassign its users first' : 'Delete role'}>
                  <span>
                    <IconButton
                      color="error"
                      disabled={loading || selected.user_count > 0}
                      onClick={() => onDelete(selected.role_id)}
                    >
                      <DeleteOutlineIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
            </Box>

            {tree.map((node) =>
              node.kind === 'group'
                ? renderGroupNode(node.label, node.modules)
                : renderModuleNode(node.module, node.permissions, 0, node.label)
            )}

            <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
              <Button
                variant="contained" disabled={!dirty || loading}
                onClick={() => onSaveGrants(selected.role_id, [...draft.values()])}
              >
                Save permissions
              </Button>
              <Button
                disabled={!dirty || loading}
                onClick={() => setDraft(new Map(selected.grants.map((g) => [g.permission, g])))}
              >
                Cancel
              </Button>
            </Box>
          </Paper>
        )}
      </Box>
    </Box>
  );
};

export default RolesForm;
