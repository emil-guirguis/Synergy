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
      fieldOrder: ['name', 'sales_desc', 'category', 'sales_price'],
      responsive: 'hide-mobile',
    });
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
    return generateFiltersFromSchema(schema.formFields);
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
