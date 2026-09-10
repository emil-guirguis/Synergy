import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, IconButton, Paper, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField,
  Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { getKitItems, saveKitItems, searchInventoryItems } from '../../services/kitItemsService';
import type { Inventory, KitItem } from '../../types/inventory';

interface KitItemsPanelProps {
  /** The KIT — the qb_item row this form is editing. */
  item?: Inventory;
  /** Saving is admin-only (PUT /api/inventory/:id/kit-items). Others get a read-only list. */
  canEdit: boolean;
}

/** One line as the grid holds it. `key` is local and stable across a drag; the server owns kit_items_id. */
interface Row {
  key: string;
  item_id: number;
  group_id: number | null;
  /** The group's label. Same value on every row of a group — the API enforces that. */
  group_desc: string | null;
  /** How many of the item this kit needs — the only editable number on a line. */
  qty: number;
  /** false = an optional accessory; the line can be dropped from a quote or pick list. */
  required: boolean;
  item_name: string | null;
  item_desc: string | null;
  item_price: number | string | null;
  item_image_url: string | null;
  /** QB stock level for the child item. Read-only, and NULL is not zero. */
  item_on_hand: number | string | null;
}

const money = (n: number | string | null) =>
  n == null || n === '' ? '' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

// pg hands NUMERIC back as a string. Number() first or toLocaleString is a no-op.
const qtyNum = (v: number | string | null | undefined, fallback = 1) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
};

// Trailing '.00' on a count is noise: 2, not 2.00 — but 2.5 stays 2.5.
const showQty = (n: number) => String(Number(n));

let keySeq = 0;
const newKey = () => `kit-row-${keySeq++}`;

const toRows = (items: KitItem[]): Row[] =>
  items.map((k) => ({
    key: `saved-${k.kit_items_id}`,
    item_id: k.item_id,
    group_id: k.group_id,
    group_desc: k.group_desc,
    qty: qtyNum(k.qty),
    required: k.required !== false,
    item_name: k.item_name,
    item_desc: k.item_desc,
    item_price: k.item_price,
    item_image_url: k.item_image_url,
    item_on_hand: k.item_on_hand,
  }));

/**
 * Rows of one group must be adjacent for the header-on-change rendering below
 * to work, and a drag can leave them scattered. Groups keep the order their
 * first row appears in, so moving a row never reshuffles the groups around it.
 */
function normalize(rows: Row[]): Row[] {
  const order: string[] = [];
  const byGroup = new Map<string, Row[]>();
  for (const r of rows) {
    const key = String(r.group_id);
    if (!byGroup.has(key)) { byGroup.set(key, []); order.push(key); }
    byGroup.get(key)!.push(r);
  }
  return order.flatMap((k) => byGroup.get(k)!);
}

/**
 * Header text for a group: its description when it has one, otherwise the bare
 * number. `null` is the catch-all every line lands in until it is grouped.
 */
const groupLabel = (g: number | null, desc: string | null) =>
  desc?.trim() ? desc : g == null ? 'Ungrouped' : `Group ${g}`;

/**
 * The contents of a kit (public.kit_items, migration 028), rendered in place of
 * the schema's UI-only `kit_items` field on the Inventory form.
 *
 * Saves itself, like DocumentsGrid — the form's own save writes qb_item columns
 * and knows nothing about these rows. Every mutation persists immediately
 * (PUT replaces the whole list), so there is no dirty state to lose when the
 * user closes the form or switches tabs.
 *
 * Drag-and-drop is hand-rolled HTML5 DnD rather than the framework's
 * EditableDataGrid: that grid has no row reordering, and reordering is the
 * point here. Dropping a row onto another row moves it there AND adopts that
 * row's group; dropping onto a group header appends it to that group.
 */
export const KitItemsPanel: React.FC<KitItemsPanelProps> = ({ item, canEdit }) => {
  const kitId = item?.qb_item_id;

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Picker state.
  const [options, setOptions] = useState<Inventory[]>([]);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Inventory | null>(null);
  const [searching, setSearching] = useState(false);

  const [dragKey, setDragKey] = useState<string | null>(null);

  // "New group" collects its description before the group exists.
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [newGroupDesc, setNewGroupDesc] = useState('');

  // A save in flight plus the newest list the user has produced since it
  // started. Drags fire faster than the round trip, and without this the
  // responses come back out of order and the last one wins wrongly.
  const savingRef = useRef(false);
  const pendingRef = useRef<Row[] | null>(null);

  const reload = useCallback(async () => {
    if (kitId == null) { setLoading(false); return; }
    setLoading(true);
    try {
      setRows(normalize(toRows(await getKitItems(kitId))));
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load kit items');
    } finally {
      setLoading(false);
    }
  }, [kitId]);

  useEffect(() => { void reload(); }, [reload]);

  // Debounced catalog search for the picker. The kit itself is filtered out —
  // the DB rejects a self-referencing line (kit_items_no_self_check).
  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const found = await searchInventoryItems(search);
        if (!cancelled) setOptions(found.filter((o) => o.qb_item_id !== kitId));
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, canEdit, kitId]);

  /** Apply a new list locally, then persist it — draining any list queued behind an in-flight save. */
  const mutate = useCallback((next: Row[]) => {
    const normalized = normalize(next);
    setRows(normalized);
    if (kitId == null) return;

    if (savingRef.current) { pendingRef.current = normalized; return; }
    savingRef.current = true;
    setSaving(true);
    void (async () => {
      try {
        let payload = normalized;
        for (;;) {
          const saved = await saveKitItems(
            kitId,
            payload.map((r) => ({
              item_id: r.item_id,
              group_id: r.group_id,
              group_desc: r.group_desc,
              qty: r.qty,
              required: r.required,
            }))
          );
          const queued = pendingRef.current;
          pendingRef.current = null;
          // Only adopt the server's rows once nothing newer is waiting —
          // otherwise this would stomp the edit the user just made.
          if (!queued) { setRows(normalize(toRows(saved))); break; }
          payload = queued;
        }
        setError(null);
      } catch (e: any) {
        setError(e?.message || 'Failed to save kit items');
        // The server rejected the list, so what is on screen is not what is
        // stored. Show the truth rather than a phantom edit.
        pendingRef.current = null;
        await reload();
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
  }, [kitId, reload]);

  const addPicked = () => {
    if (!picked) return;
    mutate([
      ...rows,
      {
        key: newKey(),
        item_id: picked.qb_item_id,
        group_id: rows.length ? rows[rows.length - 1].group_id : null,
        group_desc: rows.length ? rows[rows.length - 1].group_desc : null,
        qty: 1,
        // Lines are part of the kit unless someone says otherwise.
        required: true,
        item_name: picked.name,
        item_desc: picked.sales_desc,
        item_price: picked.sales_price,
        item_image_url: picked.image_url,
        item_on_hand: picked.quantity_on_hand,
      },
    ]);
    setPicked(null);
    setSearch('');
  };

  const removeRow = (key: string) => mutate(rows.filter((r) => r.key !== key));

  /** Move the dragged row to `targetIndex`, adopting the group it lands in. */
  const dropOnRow = (targetIndex: number) => {
    if (!dragKey) return;
    const from = rows.findIndex((r) => r.key === dragKey);
    setDragKey(null);
    if (from < 0 || from === targetIndex) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    // Splicing shifts everything after `from` left by one.
    const insertAt = from < targetIndex ? targetIndex - 1 : targetIndex;
    next.splice(insertAt, 0, {
      ...moved,
      group_id: rows[targetIndex].group_id,
      group_desc: rows[targetIndex].group_desc,
    });
    mutate(next);
  };

  /** Drop onto a group's header: append to the end of that group. */
  const dropOnGroup = (group: number | null) => {
    if (!dragKey) return;
    const from = rows.findIndex((r) => r.key === dragKey);
    setDragKey(null);
    if (from < 0) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    const lastOfGroup = next.map((r) => r.group_id).lastIndexOf(group);
    const desc = next.find((r) => r.group_id === group)?.group_desc ?? null;
    next.splice(lastOfGroup + 1, 0, { ...moved, group_id: group, group_desc: desc });
    mutate(next);
  };

  /** Commit an edited line quantity. Rejected values snap back on the reload. */
  const setQty = (key: string, raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next) || next <= 0) { void reload(); return; }
    const current = rows.find((r) => r.key === key);
    if (!current || current.qty === next) return;
    mutate(rows.map((r) => (r.key === key ? { ...r, qty: next } : r)));
  };

  const setRequired = (key: string, required: boolean) =>
    mutate(rows.map((r) => (r.key === key ? { ...r, required } : r)));

  /** Rename a whole group. Every line of it carries the label; the API agrees. */
  const describeGroup = (group: number | null, raw: string) => {
    const desc = raw.trim() === '' ? null : raw.trim();
    const current = rows.find((r) => r.group_id === group)?.group_desc ?? null;
    if (desc === current) return;
    mutate(rows.map((r) => (r.group_id === group ? { ...r, group_desc: desc } : r)));
  };

  /**
   * Create a group from the last row and name it. A group only exists as the
   * rows in it, so there is nothing to create until a row moves into it — the
   * dialog collects the description first so a group is never born unnamed.
   */
  const addGroup = (desc: string) => {
    // Next free number, so the new group never merges into an existing one.
    const nums = rows.map((r) => r.group_id).filter((g): g is number => g != null);
    const next = nums.length ? Math.max(...nums) + 1 : 1;
    mutate(rows.map((r, i) => (
      i === rows.length - 1 ? { ...r, group_id: next, group_desc: desc.trim() || null } : r
    )));
    setNewGroupDesc('');
    setGroupDialogOpen(false);
  };

  // Group headers are emitted where the group changes, which is why normalize()
  // keeps each group's rows contiguous.
  const groupStarts = useMemo(() => {
    const starts = new Set<number>();
    rows.forEach((r, i) => { if (i === 0 || rows[i - 1].group_id !== r.group_id) starts.add(i); });
    return starts;
  }, [rows]);

  if (kitId == null) {
    return <Typography variant="body2" color="text.secondary">Save the item before adding kit contents.</Typography>;
  }

  const colSpan = canEdit ? 9 : 7;

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {canEdit && (
        <Stack direction="row" spacing={1} sx={{ mb: 2 }} alignItems="center">
          <Autocomplete
            sx={{ flex: 1, minWidth: 280 }}
            size="small"
            options={options}
            value={picked}
            onChange={(_e, v) => setPicked(v)}
            inputValue={search}
            onInputChange={(_e, v) => setSearch(v)}
            loading={searching}
            // The list is already the server's search result — filtering it
            // again client-side would hide matches on fields we searched on.
            filterOptions={(x) => x}
            getOptionLabel={(o) => (o.name ? `${o.name}${o.sales_desc ? ` — ${o.sales_desc}` : ''}` : String(o.qb_item_id))}
            isOptionEqualToValue={(a, b) => a.qb_item_id === b.qb_item_id}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Add item to kit"
                placeholder="Search part number or description"
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {searching ? <CircularProgress size={16} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />
          <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={addPicked} disabled={!picked}>
            Add
          </Button>
          <Tooltip title="Names a new group and puts the last row in it — then drag other rows into it">
            <span>
              <Button size="small" onClick={() => setGroupDialogOpen(true)} disabled={!rows.length}>
                New group
              </Button>
            </span>
          </Tooltip>
          {saving && <CircularProgress size={18} />}
        </Stack>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table
          size="small"
          // A kit runs to dozens of lines, so the row is tuned for scanning the
          // list rather than for touch targets: MUI's own small-size padding
          // plus a 40px thumbnail made each row ~57px tall, and a 20-line kit
          // did not fit on a screen. Padding and font are set here once instead
          // of on every cell.
          sx={{
            '& .MuiTableCell-root': { py: 0.25, px: 1, fontSize: 13 },
            '& .MuiTableCell-head': { py: 0.5, lineHeight: 1.2 },
          }}
        >
          <TableHead>
            <TableRow>
              {canEdit && <TableCell sx={{ width: 36 }} />}
              <TableCell sx={{ width: 34 }} />
              <TableCell sx={{ width: '22%' }}>Item</TableCell>
              <TableCell>Description</TableCell>
              <TableCell sx={{ width: 74 }} align="right">Qty</TableCell>
              <Tooltip title="Unticked means the line is optional — an accessory a quote or pick list may leave out">
                <TableCell sx={{ width: 80 }} align="center">Required</TableCell>
              </Tooltip>
              <Tooltip title="QuickBooks stock level for the item itself — not part of the kit, and not editable here">
                <TableCell sx={{ width: 90 }} align="right">On Hand</TableCell>
              </Tooltip>
              <TableCell sx={{ width: '14%' }} align="right">Price</TableCell>
              {canEdit && <TableCell sx={{ width: 44 }} />}
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={colSpan} align="center"><CircularProgress size={20} /></TableCell></TableRow>
            )}
            {!loading && !rows.length && (
              <TableRow>
                <TableCell colSpan={colSpan}>
                  <Typography variant="body2" color="text.secondary">
                    No items in this kit yet.{canEdit ? ' Search for one above.' : ''}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {!loading && rows.map((row, i) => (
              <React.Fragment key={row.key}>
                {groupStarts.has(i) && (
                  <TableRow
                    sx={{ backgroundColor: 'action.hover' }}
                    onDragOver={canEdit ? (e) => e.preventDefault() : undefined}
                    onDrop={canEdit ? () => dropOnGroup(row.group_id) : undefined}
                  >
                    <TableCell colSpan={colSpan} sx={{ py: 0.25 }}>
                      {canEdit ? (
                        // Edit-in-place: an underline-only field so the header
                        // reads as a heading, not as a form row. The group
                        // number is not shown at all — it is bookkeeping the
                        // grid assigns itself, and the description is what the
                        // user actually identifies a group by.
                        <TextField
                          // Remount when the group changes so the uncontrolled
                          // defaultValue cannot go stale after a rename.
                          key={`desc-${row.group_id}-${row.group_desc ?? ''}`}
                          variant="standard"
                          placeholder={row.group_id == null ? 'Ungrouped' : 'Group description'}
                          defaultValue={row.group_desc ?? ''}
                          // Committed on blur, not per keystroke: every commit
                          // is a full save of the kit.
                          onBlur={(e) => describeGroup(row.group_id, e.target.value)}
                          sx={{ minWidth: 260, '& .MuiInputBase-input': { py: 0, fontSize: 13, fontWeight: 600 } }}
                          inputProps={{ maxLength: 200, 'data-testid': `kit-group-desc-${row.group_id ?? 'none'}` }}
                        />
                      ) : (
                        <Typography variant="body2" fontWeight={600}>{groupLabel(row.group_id, row.group_desc)}</Typography>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                <TableRow
                  draggable={canEdit}
                  onDragStart={canEdit ? () => setDragKey(row.key) : undefined}
                  onDragEnd={canEdit ? () => setDragKey(null) : undefined}
                  onDragOver={canEdit ? (e) => e.preventDefault() : undefined}
                  onDrop={canEdit ? () => dropOnRow(i) : undefined}
                  sx={{ opacity: dragKey === row.key ? 0.4 : 1, cursor: canEdit ? 'grab' : 'default' }}
                >
                  {canEdit && (
                    <TableCell sx={{ color: 'text.disabled' }}>
                      <Tooltip title="Drag to reorder or move between groups">
                        <DragIndicatorIcon fontSize="small" />
                      </Tooltip>
                    </TableCell>
                  )}
                  <TableCell>
                    {row.item_image_url ? (
                      <img
                        src={row.item_image_url}
                        alt=""
                        loading="lazy"
                        style={{ width: 26, height: 26, objectFit: 'contain', display: 'block' }}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell>{row.item_name ?? row.item_id}</TableCell>
                  <TableCell>
                    <span
                      style={{ display: 'block', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={row.item_desc ?? ''}
                    >
                      {row.item_desc ?? ''}
                    </span>
                  </TableCell>
                  <TableCell align="right">
                    {canEdit ? (
                      <TextField
                        // Uncontrolled + remount-on-change, like the group
                        // field: the value is committed on blur because each
                        // commit saves the whole kit.
                        key={`${row.key}-${row.qty}`}
                        size="small"
                        type="number"
                        defaultValue={showQty(row.qty)}
                        onBlur={(e) => setQty(row.key, e.target.value)}
                        // A drag started on the input would move the row
                        // instead of selecting text.
                        draggable
                        onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        inputProps={{ min: 0, step: 'any', style: { textAlign: 'right' }, 'data-testid': `kit-qty-${row.item_id}` }}
                        sx={{ width: 64, '& .MuiInputBase-input': { py: 0.25, fontSize: 13 } }}
                      />
                    ) : (
                      showQty(row.qty)
                    )}
                  </TableCell>
                  <TableCell align="center">
                    {canEdit ? (
                      <Checkbox
                        size="small"
                        sx={{ p: 0.25 }}
                        checked={row.required}
                        onChange={(e) => setRequired(row.key, e.target.checked)}
                        inputProps={{ 'aria-label': 'Required in this kit' } as any}
                      />
                    ) : (
                      <Typography variant="body2" color={row.required ? 'text.primary' : 'text.disabled'}>
                        {row.required ? 'Yes' : 'Optional'}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {row.item_on_hand == null ? (
                      // QB does not stock-track this item type. Blank, because
                      // '0' here would read as "out of stock".
                      <Typography variant="body2" color="text.disabled">—</Typography>
                    ) : (
                      <Typography
                        variant="body2"
                        // Short for what the kit needs: worth seeing at a
                        // glance when picking a kit off the shelf.
                        color={qtyNum(row.item_on_hand, 0) < row.qty ? 'error.main' : 'text.secondary'}
                      >
                        {showQty(qtyNum(row.item_on_hand, 0))}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">{money(row.item_price)}</TableCell>
                  {canEdit && (
                    <TableCell>
                      <IconButton size="small" sx={{ p: 0.5 }} onClick={() => removeRow(row.key)} aria-label="Remove from kit">
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  )}
                </TableRow>
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {canEdit && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Changes save as you make them — drag a row onto another to reorder it, or onto a group header to move it there.
        </Typography>
      )}

      <Dialog open={groupDialogOpen} onClose={() => setGroupDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New group</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            label="Group description"
            placeholder="e.g. Enclosure, CTs, Documentation"
            value={newGroupDesc}
            onChange={(e) => setNewGroupDesc(e.target.value)}
            // Enter is the natural commit here; the dialog has one field.
            onKeyDown={(e) => { if (e.key === 'Enter' && newGroupDesc.trim()) addGroup(newGroupDesc); }}
            inputProps={{ maxLength: 200 }}
            helperText="The last row moves into this group. Drag others in after."
          />
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setGroupDialogOpen(false)}>Cancel</Button>
          {/* A group with no description is what this dialog exists to prevent. */}
          <Button size="small" variant="contained" disabled={!newGroupDesc.trim()} onClick={() => addGroup(newGroupDesc)}>
            Add group
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default KitItemsPanel;
