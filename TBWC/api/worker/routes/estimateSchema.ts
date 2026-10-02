// ===== ESTIMATE schema (tbwc-site public.qb_estimate) =====
// Served at GET /api/schema/estimate. PK is `qb_estimate_id` (bigint identity).
// QuickBooks' own "quote" object — separate from the retired TBWC-native
// quote/quote_line tables. Header/customer/line fields are QB-owned
// (readOnly): the next sync would clobber a direct edit. memo and lines are
// editable, but a save doesn't reach QB by itself — it's staged as a 'draft'
// push (see routes/estimates.ts and qbwc/pushQueue.ts) until the form's
// "Push to QuickBooks" button promotes it. Reps get read-only access (see
// estimate:read 'own' grant, migration 056) — no estimate:write grant, so
// EstimateManagementPage drops the Save/push affordances for them entirely,
// same pattern as OrderManagementPage.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const estimateSchema = defineSchema({
  entityName: 'Estimate',
  tableName: 'qb_estimate',
  idFieldName: 'qb_estimate_id',
  titleField: 'ref_number',
  description: 'QuickBooks Estimate (quote)',
  formMaxWidth: '1100px',
  customListColumns: {},
  defaultSortBy: 'txn_date desc',

  formTabs: [
    tab({
      name: 'Estimate',
      order: 1,
      columns: '1fr 1fr',
      sections: [
        section({
          name: 'Details',
          order: 1,
          gridColumn: '1',
          fields: [
            // createOnly: editable only while creating a manual draft (no
            // txn_id yet — see routes/estimates.ts); once synced from or
            // pushed to QuickBooks, the customer is QB-owned like everything
            // else here. referenceSearch drives EstimateForm's async picker
            // for that create case (see PickableLineItemsGrid's sibling,
            // ReferenceSearchField, in @meterit/framework-frontend) — this is
            // currently the only TBWC schema using either option.
            field({
              name: 'customer_list_id', order: 1, type: FieldTypes.SELECT, default: null, required: true,
              label: 'Customer', dbField: 'customer_list_id', showOn: ['form'], createOnly: true,
              referenceSearch: { endpoint: '/customers', valueField: 'list_id', labelField: 'full_name' },
            }),
            field({ name: 'customer_name', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Customer', dbField: 'customer_name', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'ref_number', order: 3, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Estimate #', dbField: 'ref_number', maxLength: 100, showOn: ['list', 'form'] }),
            field({ name: 'sales_rep', order: 4, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Sales Rep', dbField: 'sales_rep', maxLength: 200, showOn: ['list', 'form'] }),
            // TBWC-owned (migration 059) — not from QuickBooks, never
            // touched by the sync; written directly via routes/estimates.ts's
            // WRITABLE regardless of the estimate's push/sync state.
            field({
              name: 'status', order: 5, type: FieldTypes.SELECT, default: 'quote', required: false,
              label: 'Status', dbField: 'status', showOn: ['list', 'form'],
              enumValues: ['quote', 'on_hold', 'cancelled'],
              enumLabels: { quote: 'Quote', on_hold: 'On Hold', cancelled: 'Cancelled' },
            }),
          ],
        }),
        section({
          name: 'Dates & Total',
          order: 2,
          gridColumn: '2',
          fields: [
            field({ name: 'txn_date', order: 1, type: FieldTypes.DATE, default: null, required: false, label: 'Estimate Date', dbField: 'txn_date', showOn: ['list', 'form'], createOnly: true }),
            field({ name: 'total', order: 2, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Total', dbField: 'total', showOn: ['list', 'form'] }),
            field({ name: 'time_modified', order: 3, type: FieldTypes.DATETIME, default: null, required: false, readOnly: true, label: 'QB Last Synced', dbField: 'time_modified', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Line Items',
      order: 2,
      sections: [
        section({
          name: 'Line Items',
          order: 1,
          fields: [
            // No dbField write-back — rendered by EstimateForm's renderCustomField
            // as an editable grid (admin only); reps see it read-only. Edits are
            // staged as a 'lines' push-queue draft, not written to this column
            // directly (see routes/estimates.ts) once synced — but for a
            // still-local draft (createOnly-equivalent: gated on txn_id, not
            // BaseForm's isNew — see EstimateForm), lineItemPicker drives an
            // add/remove grid with an async item picker (framework's
            // PickableLineItemsGrid) instead of the fixed-rows edit grid.
            field({
              name: 'lines', order: 1, type: FieldTypes.OBJECT, default: null, dbField: 'lines', showOn: ['form'],
              lineItemPicker: {
                itemSearch: { endpoint: '/inventory', valueField: 'list_id', labelField: 'full_name' },
                descField: 'desc', quantityField: 'quantity', rateField: 'rate',
              },
            }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Notes',
      order: 3,
      sections: [
        section({
          name: 'Notes',
          order: 1,
          fields: [
            // Editable — staged as a 'draft' push-queue edit on save (see
            // routes/estimates.ts), sent to QB only once the form's "Push to
            // QuickBooks" button promotes it to 'pending'. Shows the queued
            // value immediately either way (COALESCE in estimates.ts's GET).
            field({ name: 'memo', order: 1, type: FieldTypes.TEXTAREA, default: '', required: false, label: 'Memo', dbField: 'memo', maxLength: 4095, showOn: ['form'], rows: 4 }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Documents',
      order: 4,
      sections: [
        section({
          name: 'Documents',
          order: 1,
          fields: [
            // No dbField — UI-only anchor, same as orderSchema's Documents tab.
            // Rows live in public.document keyed by (entity_type='estimate',
            // entity_id=<qb_estimate_id>).
            field({ name: 'documents', order: 1, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    qb_estimate_id: field({ name: 'qb_estimate_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'qb_estimate_id' }),
    txn_id: field({ name: 'txn_id', type: FieldTypes.STRING, default: null, readOnly: true, label: 'QB Txn ID', dbField: 'txn_id' }),
    // Not list/form-shown — options carrier for the list's rep filter, keyed
    // by list_id (mirrors orderSchema's sales_rep_list_id); injected at serve
    // time from public.qb_sales_rep (see routes/schema.ts).
    sales_rep_list_id: field({ name: 'sales_rep_list_id', type: FieldTypes.SELECT, default: null, readOnly: true, label: 'Sales Rep', dbField: 'sales_rep_list_id', enumValues: [] }),
  },
  validation: {},
});
