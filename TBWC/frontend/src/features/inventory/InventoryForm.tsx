import React, { useEffect, useState } from 'react';
import { MenuItem, TextField } from '@mui/material';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { useInventoryEnhanced } from './inventoryStore';
import { InventoryImagePanel } from './InventoryImagePanel';
import { KitItemsPanel } from './KitItemsPanel';
import { useAuth } from '../../hooks/useAuth';
import type { Inventory, ItemType } from '../../types/inventory';

interface InventoryFormProps {
  item?: Inventory;
  onCancel: () => void;
  loading?: boolean;
}

const TYPE_OPTIONS: ItemType[] = ['item', 'kit'];

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

  // The form instance is reused across records (a row click reuses it), so this
  // has to follow the item rather than only the first mount.
  useEffect(() => { setLiveType(item?.type ?? 'item'); }, [item?.qb_item_id, item?.type]);

  return (
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
  );
};

export default InventoryForm;
