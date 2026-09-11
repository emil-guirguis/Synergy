import React, { useEffect, useState } from 'react';
import { Box, ButtonBase, Dialog, MenuItem, TextField, Tooltip } from '@mui/material';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { useInventoryEnhanced } from './inventoryStore';
import { InventoryImagePanel } from './InventoryImagePanel';
import { KitItemsPanel } from './KitItemsPanel';
import { useAuth } from '../../hooks/useAuth';
import type { ImageStatus, Inventory, ItemType } from '../../types/inventory';

interface InventoryFormProps {
  item?: Inventory;
  onCancel: () => void;
  loading?: boolean;
}

const TYPE_OPTIONS: ItemType[] = ['item', 'kit'];

/** The tab the thumbnail sits on. Named once so the guard below cannot drift from the schema. */
const FIRST_TAB = 'Item';

/** A ring around the thumbnail, so an unreviewed picture is visible as one at a glance. */
const STATUS_RING: Record<ImageStatus, string> = {
  pending: 'divider',
  auto: 'warning.main',
  approved: 'success.main',
  rejected: 'error.main',
  none: 'divider',
};

/** Schema-driven inventory form (GET /api/schema/inventory); store handles create/update. */
export const InventoryForm: React.FC<InventoryFormProps> = ({ item, onCancel, loading = false }) => {
  const inventory = useInventoryEnhanced();
  const auth = useAuth();
  const isAdmin = !!auth.user?.is_admin;

  // Drives BaseForm's `variant`, which the schema's `visibleFor: ['kit']` gates
  // the Kit Items tab on. Held here rather than read off `item` so the tab
  // appears the moment Type is switched to kit instead of only after a save —
  // which is why the Type field below is hand-rendered: owning its onChange is
  // the only way to see the value BaseForm holds internally.
  const [liveType, setLiveType] = useState<string>(item?.type ?? 'item');

  // The Kit Items grid is nine columns wide (drag, image, item, description,
  // qty, required, on hand, price, delete) and the schema's 900px form squeezes
  // the description down to nothing. Widen the form for that tab only — the
  // field tabs stay narrow, because a wide row of text inputs is worse to read,
  // not better. 1200px is the modal's own xl width: enough for the grid, and it
  // stops short of stretching edge to edge on a big monitor.
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // The catalog image used to have a tab of its own. It is a review workflow
  // that most people opening an item never touch, so it now rides in the tab
  // bar as a thumbnail and opens the same panel in a dialog. The schema keeps
  // the tab (the list's image column and status filter are generated from its
  // fields) — the form just hides it.
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(item?.image_url ?? null);
  const [imageStatus, setImageStatus] = useState<ImageStatus>(item?.image_status ?? 'pending');

  // The form instance is reused across records (a row click reuses it), so this
  // has to follow the item rather than only the first mount.
  useEffect(() => { setLiveType(item?.type ?? 'item'); }, [item?.qb_item_id, item?.type]);

  // Same reuse story as liveType: a row click swaps the item under this instance.
  useEffect(() => {
    setImageUrl(item?.image_url ?? null);
    setImageStatus(item?.image_status ?? 'pending');
    setImageOpen(false);
  }, [item?.qb_item_id, item?.image_url, item?.image_status]);

  // activeTab is null until BaseForm reports its first tab, which is this one.
  const onFirstTab = activeTab === null || activeTab === FIRST_TAB;

  const thumbnail = item?.qb_item_id ? (
    <Tooltip title={imageUrl ? 'Catalog image — click to enlarge' : `No catalog image (${imageStatus})`}>
      {/* A disabled ButtonBase does not fire the events Tooltip listens for, so
          the span is what keeps the tooltip working on an item with no image. */}
      <Box component="span" sx={{ display: 'inline-flex' }}>
      <ButtonBase
        data-testid="inventory-image-thumb"
        disabled={!imageUrl}
        onClick={() => setImageOpen(true)}
        sx={{
          width: 44,
          height: 44,
          borderRadius: 1,
          border: '1px solid',
          borderColor: STATUS_RING[imageStatus],
          bgcolor: '#fff',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {imageUrl ? (
          <Box
            component="img"
            src={imageUrl}
            alt={item.name ?? 'Catalog image'}
            sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : (
          <ImageOutlinedIcon fontSize="small" sx={{ color: 'text.disabled' }} />
        )}
      </ButtonBase>
      </Box>
    </Tooltip>
  ) : null;

  return (
    <>
    <BaseForm
      schemaName="inventory"
      entity={item}
      store={inventory}
      onCancel={onCancel}
      className="inventory-form"
      loading={loading}
      showTabs={true}
      variant={liveType}
      onTabChange={setActiveTab}
      hiddenTabs={['Image']}
      tabHeaderActions={onFirstTab ? thumbnail : undefined}
      // Falls through to the schema's own formMaxWidth (900px) when undefined.
      formMaxWidth={activeTab === 'Kit Items' ? '1200px' : undefined}
      // `documents` and `kit_items` are UI-only fields (no dbField) — their
      // grids save their own rows. `image_url` is schema-readOnly and saved
      // through its own PATCH route, so it must not ride along in the form's
      // payload either. (Everything the PUT does not allowlist is dropped
      // server-side too — this just keeps the request honest.)
      fieldsToClean={['id', 'documents', 'kit_items', 'image_url']}
      renderCustomField={(fieldName, fieldDef, value, _error, isDisabled, onChange) => {
        // `type` and `notes` are the only two writable columns
        // (inventory.ts's PUT_ALLOWLIST) and the PUT is admin-only. The schema
        // can't say "readOnly unless admin", so a rep would otherwise get an
        // editable field and a 403 on save — show them the value, disabled.
        if (!isAdmin && (fieldName === 'type' || fieldName === 'notes')) {
          return (
            <TextField
              fullWidth
              size="small"
              disabled
              label={fieldName === 'type' ? 'Type' : 'Notes'}
              multiline={fieldName === 'notes'}
              minRows={fieldName === 'notes' ? 3 : undefined}
              value={value ?? ''}
            />
          );
        }
        if (fieldName === 'type') {
          return (
            <TextField
              select
              fullWidth
              size="small"
              label={fieldDef?.label ?? 'Type'}
              disabled={isDisabled}
              value={value ?? 'item'}
              onChange={(e) => {
                // BaseForm still owns the value for the save; `liveType` only
                // decides which tabs are on screen.
                onChange(e.target.value);
                setLiveType(e.target.value);
              }}
              helperText="A kit is a bundle — set this to show its Kit Items tab."
            >
              {((fieldDef?.enumValues as string[] | undefined) ?? TYPE_OPTIONS).map((opt) => (
                <MenuItem key={opt} value={opt}>{opt}</MenuItem>
              ))}
            </TextField>
          );
        }
        if (fieldName === 'image_url') {
          return <InventoryImagePanel item={item} canReview={isAdmin} />;
        }
        if (fieldName === 'kit_items') {
          return <KitItemsPanel item={item} canEdit={isAdmin} />;
        }
        if (fieldName === 'documents') {
          return (
            <DocumentsGrid
              entityType="inventory"
              entityId={item?.id}
              api={documentsApi}
              storage={documentsStorage}
            />
          );
        }
        return null;
      }}
    />
    {/* Just the picture, big. The verdict buttons live on the Image tab, which
        is hidden for now — see hiddenTabs above. */}
    <Dialog
      open={imageOpen}
      onClose={() => setImageOpen(false)}
      maxWidth="lg"
      PaperProps={{ sx: { bgcolor: '#fff', m: 2 } }}
    >
      <Box
        onClick={() => setImageOpen(false)}
        sx={{ cursor: 'zoom-out', display: 'flex', p: 1 }}
      >
        <Box
          component="img"
          src={imageUrl ?? undefined}
          alt={item?.name ?? 'Catalog image'}
          sx={{ maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain' }}
        />
      </Box>
    </Dialog>
    </>
  );
};

export default InventoryForm;
