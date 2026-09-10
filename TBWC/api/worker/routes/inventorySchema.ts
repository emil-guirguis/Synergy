// ===== INVENTORY schema (tbwc-site public.qb_item) =====
// Served at GET /api/schema/inventory. PK is `qb_item_id` (bigint identity).
// Backing table is the QB-synced staging table.
//
// Almost everything is readOnly, deliberately: QB-owned fields are the sync's
// to write, and the TBWC-owned columns from migration 012 (category, UPC,
// pricing/logistics) stay frozen while the qb_item rebase is verified. The
// exceptions are the kit fields from migration 028 — `type` and `notes` — the
// only two columns inventory.ts's PUT_ALLOWLIST will write. Making another
// field editable means changing BOTH: this readOnly and that allowlist.
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
            // TBWC's own classification, unrelated to QB's item_type above:
            // 'kit' means the record is a bundle and its contents live in
            // kit_items (the Kit Items tab appears for it). Editable — see the
            // header. On the list too, so the kits can be filtered out of a
            // 1200-row catalog with the generated dropdown.
            field({ name: 'type', order: 4, type: FieldTypes.SELECT, default: 'item', required: true, label: 'Type', dbField: 'type', enumValues: ['item', 'kit'], showOn: ['list', 'form'] }),
            field({ name: 'category', order: 5, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Category', dbField: 'category', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'upc_code', order: 6, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'UPC', dbField: 'upc_code', maxLength: 100, showOn: ['form'] }),
            field({ name: 'distribution_type', order: 7, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Distribution', dbField: 'distribution_type', maxLength: 100, showOn: ['form'] }),
            field({ name: 'is_active', order: 8, type: FieldTypes.BOOLEAN, default: true, required: false, readOnly: true, label: 'Active', dbField: 'is_active', showOn: ['form'] }),
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
            // QuickBooks' stock level (migration 029), synced on every Item
            // pull and never written here. NULL for item types QB does not
            // stock-track (Service, NonInventory…), which the form shows as
            // empty — not 0, which would read as "out of stock".
            field({ name: 'quantity_on_hand', order: 9, type: FieldTypes.NUMBER, default: null, required: false, readOnly: true, label: 'On Hand (QB)', dbField: 'quantity_on_hand', showOn: ['list', 'form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Kit Items',
      order: 2,
      // Only a kit has contents, so only a kit gets the tab. `visibleFor` is
      // matched against BaseForm's `variant`, which TBWC's InventoryForm drives
      // from the live value of the Type field — flipping Type to kit shows this
      // tab immediately, without a save/reopen round trip.
      visibleFor: ['kit'],
      sections: [
        section({
          name: 'Kit Items',
          order: 1,
          fields: [
            // No dbField — UI-only anchor, same trick as `documents` below.
            // TBWC's InventoryForm renders KitItemsPanel here; rows live in
            // public.kit_items and are saved by that panel's own
            // PUT /api/inventory/:id/kit-items, never by this form's save.
            // The tab is rendered for every item; the panel itself says to set
            // Type = kit first, since a non-kit having contents is meaningless.
            field({ name: 'kit_items', order: 1, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Documents',
      order: 3,
      sections: [
        section({
          name: 'Documents',
          order: 1,
          fields: [
            // No dbField — UI-only anchor. TBWC's InventoryForm renders the shared
            // framework DocumentsGrid here; rows live in public.document keyed by
            // (entity_type='inventory', entity_id=<record id>), saved on edit, not
            // with this form.
            field({ name: 'documents', order: 1, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Image',
      order: 4,
      sections: [
        section({
          name: 'Image',
          order: 1,
          fields: [
            // Catalog thumbnail for the printed price sheet. Populated by
            // scripts/fetch-item-images.cjs; see migrations/027-inventory-images.sql.
            // On its own tab because it is a review workflow, not a property of
            // the item: TBWC's InventoryForm swaps `image_url` for the
            // InventoryImagePanel (preview + approve/reject), and that needs the
            // width. Every field stays readOnly — the verdict is saved by
            // PATCH /api/inventory/:id/image, never by this form's save.
            // The only form-shown field on this tab, and InventoryForm renders
            // the InventoryImagePanel in its place. URL rather than STRING so
            // the list's filter generators skip it — nobody filters by image
            // URL, and a stray free-text box in the filter bar is just noise.
            field({ name: 'image_url', order: 1, type: FieldTypes.URL, default: null, required: false, readOnly: true, label: 'Image', dbField: 'image_url', showOn: ['list', 'form'] }),
            // List-only: the panel already shows status, match % and source as
            // chips, so repeating them here as disabled inputs would be noise.
            // It stays in a tab (not entityFields) because the list column and
            // its status dropdown filter are both generated from formFields.
            field({ name: 'image_status', order: 2, type: FieldTypes.SELECT, default: 'pending', required: false, readOnly: true, label: 'Image Status', dbField: 'image_status', enumValues: ['pending', 'auto', 'approved', 'rejected', 'none'], showOn: ['list'] }),
          ],
        }),
      ],
    }),
    tab({
      // Notes sits last by convention: every module's Notes tab does, so the
      // tab bar reads the same way from one record type to the next.
      name: 'Notes',
      order: 5,
      sections: [
        section({
          name: 'Notes',
          order: 1,
          fields: [
            // TBWC-internal scratchpad (migration 028) — not synced to QB, not
            // printed. Its own tab, not a section under Item: it is free text
            // that grows, and it would otherwise push Pricing off the screen.
            // Form-only — notes run long and a truncated list column would be
            // worse than no column.
            field({ name: 'notes', order: 1, type: FieldTypes.TEXTAREA, default: '', required: false, label: 'Notes', dbField: 'notes', maxLength: 4000, showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    // Read off the row (findAll/findById select table.*) by InventoryImagePanel
    // and the list's thumbnail tooltip — not rendered as form inputs.
    image_confidence: field({ name: 'image_confidence', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'Match %', dbField: 'image_confidence' }),
    image_source_url: field({ name: 'image_source_url', type: FieldTypes.URL, default: null, readOnly: true, label: 'Image Source', dbField: 'image_source_url' }),
    image_source: field({ name: 'image_source', type: FieldTypes.STRING, default: null, readOnly: true, label: 'Image Picked By', dbField: 'image_source' }),
    image_updated_at: field({ name: 'image_updated_at', type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Image Updated', dbField: 'image_updated_at' }),
    qb_item_id: field({ name: 'qb_item_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'qb_item_id' }),
    list_id: field({ name: 'list_id', type: FieldTypes.STRING, default: null, readOnly: true, label: 'QB List ID', dbField: 'list_id' }),
    full_name: field({ name: 'full_name', type: FieldTypes.STRING, default: null, readOnly: true, label: 'QB Full Name', dbField: 'full_name' }),
  },
  validation: {},
});
