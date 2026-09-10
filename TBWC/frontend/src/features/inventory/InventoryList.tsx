import React, { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { useInventoryEnhanced } from './inventoryStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission } from '../../types/auth';
import type { Inventory } from '../../types/inventory';

interface InventoryListProps {
  onInventoryEdit?: (item: Inventory) => void;
  onInventoryCreate?: () => void;
  authContext?: { checkPermission: (p: any) => boolean; user: any };
}

export const InventoryList: React.FC<InventoryListProps> = ({ onInventoryEdit, onInventoryCreate, authContext: authProp }) => {
  const realAuth = useAuth();
  const auth = authProp ?? realAuth;
  const { schema } = useSchema('inventory');
  const [searchParams, setSearchParams] = useSearchParams();

  const columns = useMemo(() => {
    if (!schema) return [];
    const cols = generateColumnsFromSchema<Inventory>(schema.formFields, {
      fieldOrder: ['image_url', 'name', 'type', 'sales_desc', 'category', 'image_status', 'quantity_on_hand', 'sales_price'],
      responsive: 'hide-mobile',
    });

    // The thumbnail column is the review screen: scanning 1155 pictures against
    // their descriptions is the only practical way to find the wrong ones, and
    // that is far quicker down a list than one record at a time.
    const imgCol = cols.find((c) => c.key === 'image_url');
    if (imgCol) {
      imgCol.label = '';
      imgCol.sortable = false;
      imgCol.render = (_value, row) => (
        <div
          style={{
            width: 52,
            height: 52,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid rgba(0,0,0,0.12)',
            borderRadius: 4,
            background: '#fff',
            overflow: 'hidden',
          }}
          // Provenance without a click: which rule or search produced this.
          title={
            row.image_url
              ? `${row.image_source ?? 'unknown'} · ${row.image_confidence ?? '?'}% · ${row.image_status}`
              : row.image_status === 'none'
                ? 'No product photo for this line type'
                : 'No image yet'
          }
        >
          {row.image_url ? (
            <img
              src={row.image_url}
              alt=""
              loading="lazy"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              // A dead bucket object must not leave a broken-image glyph in
              // every row — blank reads as "missing", which is the truth.
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          ) : (
            <span style={{ fontSize: 10, opacity: 0.4 }}>{row.image_status === 'none' ? '—' : '?'}</span>
          )}
        </div>
      );
    }

    // Only the two states that need a human read as anything; approved and
    // 'none' are settled and should stay visually quiet.
    const statusCol = cols.find((c) => c.key === 'image_status');
    if (statusCol) {
      statusCol.label = 'Image';
      statusCol.render = (_value, row) => {
        const color =
          row.image_status === 'auto' ? '#b26a00'
            : row.image_status === 'rejected' ? '#c62828'
              : row.image_status === 'approved' ? '#2e7d32'
                : 'rgba(0,0,0,0.45)';
        const text =
          row.image_status === 'auto' ? `unreviewed${row.image_confidence != null ? ` (${row.image_confidence}%)` : ''}`
            : row.image_status;
        return <span style={{ color, fontSize: 12 }}>{text}</span>;
      };
    }
    // A kit behaves differently everywhere else (it has contents), so it should
    // be findable by eye in a 1200-row list. The 'item' default stays blank
    // rather than repeating itself down every row.
    const typeCol = cols.find((c) => c.key === 'type');
    if (typeCol) {
      typeCol.render = (_value, row) =>
        row.type === 'kit'
          ? <span style={{ fontSize: 12, fontWeight: 600, color: '#1565c0' }}>KIT</span>
          : <span style={{ fontSize: 12, opacity: 0.35 }}>item</span>;
    }
    // Stock level (migration 029). NULL means QB does not stock-track this item
    // type at all (Service, NonInventory…) — shown as a dash, because a 0 there
    // would read as "out of stock" for something that is always available.
    // Zero itself is worth flagging, so it is the one value that gets colour.
    const onHandCol = cols.find((c) => c.key === 'quantity_on_hand');
    if (onHandCol) {
      onHandCol.label = 'On Hand';
      onHandCol.align = 'right';
      onHandCol.tooltip = 'QuickBooks stock level. Blank means QB does not stock-track this item type.';
      onHandCol.render = (_value, row) => {
        if (row.quantity_on_hand == null) return <span style={{ opacity: 0.35 }}>—</span>;
        const n = Number(row.quantity_on_hand);
        return <span style={{ color: n <= 0 ? '#c62828' : undefined }}>{Number.isFinite(n) ? String(n) : ''}</span>;
      };
    }
    // Descriptions can run long (full QB SalesDesc text) and would otherwise
    // stretch the whole table — cap the column and truncate with an ellipsis.
    const descCol = cols.find((c) => c.key === 'sales_desc');
    if (descCol) {
      descCol.render = (_value, row) => (
        <span
          style={{
            display: 'block',
            maxWidth: 420,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={row.sales_desc ?? ''}
        >
          {row.sales_desc ?? ''}
        </span>
      );
    }
    return cols;
  }, [schema]);

  const filters = useMemo(() => {
    if (!schema) return [];
    // On Hand is a free-text (ILIKE) filter by generation — every list-shown
    // number is — and "contains" on a stock count is misleading: 14 matches 140
    // and 214. The column and its sort stay; only the filter box is dropped.
    const generated = generateFiltersFromSchema(schema.formFields).filter((f) => f.key !== 'quantity_on_hand');
    // "Has a picture at all" is the question while working through the catalog,
    // and Image Status can't answer it in one pick — auto and approved both have
    // one, pending/rejected/none don't. Hand-added because it maps to a NULL
    // check on image_url, not to a column the schema can generate a filter from.
    return [
      ...generated,
      {
        key: 'hasImage',
        label: 'Image',
        type: 'select' as const,
        options: [
          { label: 'Has image', value: 'true' },
          { label: 'No image', value: 'false' },
        ],
        placeholder: 'All Images',
      },
    ];
  }, [schema]);

  const baseList = useBaseList<Inventory, any>({
    entityName: 'inventory',
    entityNamePlural: 'inventory',
    useStore: useInventoryEnhanced,
    features: {
      // allowEdit stays on so a row click still opens the form — it's just a
      // read-only view for now (every field is schema-readOnly, and the PUT
      // route 405s). allowEdit gates whether handleEdit fires at all, so
      // turning it off would block opening the form, not just saving.
      allowCreate: false,
      allowEdit: true,
      allowDelete: false,
      allowBulkActions: false,
      allowExport: false,
      allowImport: false,
      allowSearch: true,
      allowFilters: true,
      allowStats: false,
    },
    permissions: {
      create: Permission.INVENTORY_CREATE,
      update: Permission.INVENTORY_UPDATE,
      delete: Permission.INVENTORY_DELETE,
    },
    columns,
    filters,
    onEdit: onInventoryEdit,
    onCreate: onInventoryCreate,
    authContext: auth,
  });

  // AI chat search results link here with ?openId=<qb_item_id> to open a
  // specific inventory item's form directly (see features/ai/AiChatPage.tsx)
  // — fetch that one record (not necessarily on the current page/filter) and
  // open it the same way a row click does, then drop the param so it doesn't
  // reopen on every future visit to this page.
  const inventoryHook = useInventoryEnhanced();
  useEffect(() => {
    const openId = searchParams.get('openId');
    if (!openId || !onInventoryEdit) return;
    inventoryHook
      .fetchItem(openId)
      .then((entity) => entity && onInventoryEdit(entity as unknown as Inventory))
      .catch((err) => console.error('[InventoryList] Failed to open item from AI chat link:', err));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('openId');
        return next;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <div className="inventory-list">
      <BaseList
        title="Inventory"
        filters={baseList.renderFilters()}
        onCreateClick={baseList.canCreate ? baseList.handleCreate : undefined}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No inventory items found."
        onEdit={baseList.handleEdit}
        pagination={baseList.pagination}
      />
    </div>
  );
};

export default InventoryList;
