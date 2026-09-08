// ===== INVENTORY schema (tbwc-site public.qb_item) =====
// Served at GET /api/schema/inventory. PK is `qb_item_id` (bigint identity).
// Backing table is the QB-synced staging table. Temporarily all-readOnly per
// request while the qb_item rebase is still being verified — TBWC-owned
// fields (category, UPC, pricing/logistics) are the ones meant to eventually
// become editable (they're new columns the QBWC upsert never SETs, so they'd
// survive every re-sync), but editing is off for now; see inventory.ts's PUT.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const inventorySchema = defineSchema({
  entityName: 'Inventory',
  tableName: 'qb_item',
  idFieldName: 'qb_item_id',
  description: 'TBWC product catalog (QuickBooks item list + TBWC-owned fields)',
  formMaxWidth: '900px',
  customListColumns: {},

  formTabs: [
    tab({
      name: 'Item',
      order: 1,
      sections: [
        section({
          name: 'Identity',
          order: 1,
          fields: [
            field({ name: 'name', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Item Name / Part #', dbField: 'name', maxLength: 200, showOn: ['list', 'form'] }),
            field({ name: 'sales_desc', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Description', dbField: 'sales_desc', maxLength: 2000, showOn: ['list', 'form'] }),
            field({ name: 'item_type', order: 3, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'QB Item Type', dbField: 'item_type', showOn: ['form'] }),
            field({ name: 'category', order: 4, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Category', dbField: 'category', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'upc_code', order: 5, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'UPC', dbField: 'upc_code', maxLength: 100, showOn: ['form'] }),
            field({ name: 'distribution_type', order: 6, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Distribution', dbField: 'distribution_type', maxLength: 100, showOn: ['form'] }),
            field({ name: 'is_active', order: 7, type: FieldTypes.BOOLEAN, default: true, required: false, readOnly: true, label: 'Active', dbField: 'is_active', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Pricing',
          order: 2,
          fields: [
            field({ name: 'sales_price', order: 1, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'QB Sales Price', dbField: 'sales_price', showOn: ['list', 'form'] }),
            field({ name: 'base_price', order: 2, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Base Price', dbField: 'base_price', showOn: ['form'] }),
            field({ name: 'msrp', order: 3, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'MSRP', dbField: 'msrp', showOn: ['form'] }),
            field({ name: 'dnet_cost', order: 4, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'D-NET Cost', dbField: 'dnet_cost', showOn: ['form'] }),
            field({ name: 'moq', order: 5, type: FieldTypes.NUMBER, default: null, required: false, readOnly: true, label: 'MOQ', dbField: 'moq', showOn: ['form'] }),
            field({ name: 'pack_qty', order: 6, type: FieldTypes.NUMBER, default: null, required: false, readOnly: true, label: 'Pack Qty', dbField: 'pack_qty', showOn: ['form'] }),
            field({ name: 'service_days', order: 7, type: FieldTypes.NUMBER, default: null, required: false, readOnly: true, label: 'Service Days', dbField: 'service_days', showOn: ['form'] }),
            field({ name: 'unit_weight', order: 8, type: FieldTypes.NUMBER, default: null, required: false, readOnly: true, label: 'Unit Weight (lbs)', dbField: 'unit_weight', showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    qb_item_id: field({ name: 'qb_item_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'qb_item_id' }),
    list_id: field({ name: 'list_id', type: FieldTypes.STRING, default: null, readOnly: true, label: 'QB List ID', dbField: 'list_id' }),
    full_name: field({ name: 'full_name', type: FieldTypes.STRING, default: null, readOnly: true, label: 'QB Full Name', dbField: 'full_name' }),
  },
  validation: {},
});
