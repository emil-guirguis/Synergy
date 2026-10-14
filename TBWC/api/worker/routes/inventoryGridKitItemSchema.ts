// ===== INVENTORY > KIT ITEMS grid (public.kit_items, migration 028) =====
// Served at GET /api/schema/inventoryGridKitItem. PK is `kit_items_id`.
// Child-row grid on a kit's Inventory form: `qb_item_id` is the KIT (the
// parent), `item_id` the child line. Gives the grid its own
// inventoryGridKitItem:read/create/write/delete (Settings > Roles >
// Inventory > Kit Items). The UI (KitItemsPanel.tsx) still saves the whole
// ordered list at once — drag reorders rewrite order_by on every row — so
// inventory.ts's PUT works out which rows were added, removed or changed and
// requires the matching permission for each kind.
import {
  defineSchema,
  field,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const inventoryGridKitItemSchema = defineSchema({
  entityName: 'Kit Item',
  tableName: 'kit_items',
  idFieldName: 'kit_items_id',
  description: 'Items contained in a kit',
  customListColumns: {},
  defaultSortBy: 'order_by asc',
  parent: { entity: 'inventory', foreignKey: 'qb_item_id', label: 'Kit Items', orderField: 'order_by' },

  formFields: {
    item_id: field({
      name: 'item_id', order: 1, type: FieldTypes.SELECT, default: null, required: true,
      label: 'Item', dbField: 'item_id', showOn: ['list', 'form'],
      referenceSearch: { endpoint: '/inventory', valueField: 'qb_item_id', labelField: 'name', displayField: 'item_name' },
    }),
    item_desc: field({ name: 'item_desc', order: 2, type: FieldTypes.STRING, default: null, readOnly: true, label: 'Description', showOn: ['list', 'form'] }),
    qty: field({ name: 'qty', order: 3, type: FieldTypes.NUMBER, default: 1, required: true, label: 'Qty', dbField: 'qty', min: 0, showOn: ['list', 'form'] }),
    required: field({ name: 'required', order: 4, type: FieldTypes.BOOLEAN, default: true, label: 'Required', dbField: 'required', showOn: ['list', 'form'] }),
    item_on_hand: field({ name: 'item_on_hand', order: 5, type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'On Hand', showOn: ['list', 'form'] }),
    item_price: field({ name: 'item_price', order: 6, type: FieldTypes.CURRENCY, default: null, readOnly: true, label: 'Price', showOn: ['list', 'form'] }),
  },

  entityFields: {
    kit_items_id: field({ name: 'kit_items_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'kit_items_id' }),
    group_id: field({ name: 'group_id', type: FieldTypes.NUMBER, default: null, label: 'Group', dbField: 'group_id' }),
    group_desc: field({ name: 'group_desc', type: FieldTypes.STRING, default: null, label: 'Group Description', dbField: 'group_desc' }),
  },
  validation: {},
});
