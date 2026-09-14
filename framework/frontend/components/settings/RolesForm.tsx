import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, Divider, IconButton, List, ListItemButton,
  ListItemText, MenuItem, Paper, Select, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import './SettingsForm.css';

export type GrantScope = 'all' | 'own';

export interface RoleGrant {
  permission: string;
  scope: GrantScope;
  hidden_fields: string[];
}

export interface ManagedRole {
  role_id: number;
  code: string;
  name: string;
  is_system: boolean;
  user_count: number;
  grants: RoleGrant[];
}

export interface RolesFormProps {
  roles: ManagedRole[];
  /** The permission strings this app's routes enforce. */
  catalog: string[];
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
  roles, catalog, onCreate, onRename, onSaveGrants, onDelete, loading, error,
}) => {
  const [selectedId, setSelectedId] = useState<number | null>(roles[0]?.role_id ?? null);
  const [draft, setDraft] = useState<Map<string, RoleGrant>>(new Map());
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ code: '', name: '' });

  const selected = roles.find((r) => r.role_id === selectedId) ?? null;

  // Re-seed the working copy whenever the selection changes or the server sends
  // a fresh list, so an edit never carries over onto a different role.
  useEffect(() => {
    setDraft(new Map((selected?.grants ?? []).map((g) => [g.permission, g])));
    setName(selected?.name ?? '');
  }, [selected]);

  useEffect(() => {
    if (selectedId === null && roles.length) setSelectedId(roles[0].role_id);
  }, [roles, selectedId]);

  const byModule = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const p of catalog) {
      const m = moduleOf(p);
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m)!.push(p);
    }
    return [...groups.entries()];
  }, [catalog]);

  const dirty = useMemo(() => {
    if (!selected) return false;
    const original = new Map(selected.grants.map((g) => [g.permission, g]));
    if (original.size !== draft.size) return true;
    for (const [permission, g] of draft) {
      const o = original.get(permission);
      if (!o || o.scope !== g.scope || o.hidden_fields.join(',') !== g.hidden_fields.join(',')) return true;
    }
    return false;
  }, [selected, draft]);

  const toggle = (permission: string) => {
    setDraft((prev) => {
      const next = new Map(prev);
      if (next.has(permission)) next.delete(permission);
      else next.set(permission, { permission, scope: 'all', hidden_fields: [] });
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

  return (
    <Box className="settings-form">
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
        <Paper variant="outlined" sx={{ width: 240, flexShrink: 0 }}>
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

            {byModule.map(([module, permissions]) => (
              <Box key={module} sx={{ mb: 2 }}>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{titleCase(module)}</Typography>
                <Divider sx={{ mb: 1 }} />
                {permissions.map((permission) => {
                  const grant = draft.get(permission);
                  return (
                    <Box
                      key={permission}
                      sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.25 }}
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
                })}
              </Box>
            ))}

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
