// ===== QUOTE schema (tbwc-site public.quote) =====
// Served at GET /api/schema/quote. PK is `quote_id` (bigint identity).
// TBWC-owned, local-only (migration 070 renamed this back from the
// QuickBooks-Estimate-backed Estimates module and dropped the push-to-QB
// workflow entirely) — every field below is directly editable via
// routes/quotes.ts's PUT, no staging/push to reconcile against QuickBooks.
// Reps get read-only access (see quote:read 'own' grant, migration 056) —
// no quote:write grant, so QuoteManagementPage drops the Save affordance for
// them entirely, same pattern as OrderManagementPage.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const quoteSchema = defineSchema({
  entityName: 'Quote',
  tableName: 'quote',
  idFieldName: 'quote_id',
  titleField: 'ref_number',
  description: 'TBWC quote',
  formMaxWidth: '1100px',
  customListColumns: {},
  defaultSortBy: 'txn_date desc',

  formTabs: [
    tab({
      name: 'Quote',
      order: 1,
      columns: '1fr 1fr',
      sections: [
        section({
          name: 'Details',
          order: 1,
          gridColumn: '1',
          fields: [
            // referenceSearch drives QuoteForm's async picker (see
            // PickableLineItemsGrid's sibling, ReferenceSearchField, in
            // @meterit/framework-frontend) — this is currently the only TBWC
            // schema using either option.
            field({
              name: 'customer_list_id', order: 1, type: FieldTypes.SELECT, default: null, required: true,
              label: 'Customer', dbField: 'customer_list_id', showOn: ['form'],
              referenceSearch: { endpoint: '/customers', valueField: 'list_id', labelField: 'full_name' },
            }),
            field({ name: 'customer_name', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Customer', dbField: 'customer_name', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'ref_number', order: 3, type: FieldTypes.STRING, default: '', required: false, label: 'Quote #', dbField: 'ref_number', maxLength: 100, showOn: ['list', 'form'] }),
            field({ name: 'sales_rep', order: 4, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Sales Rep', dbField: 'sales_rep', maxLength: 200, showOn: ['list', 'form'] }),
            // TBWC-owned, manually entered — no QB source, same as
            // qb_sales_order.job_name (migration 020/076).
            field({ name: 'job_name', order: 5, type: FieldTypes.STRING, default: '', required: false, label: 'Job Name', dbField: 'job_name', maxLength: 300, showOn: ['list', 'form'] }),
            // TBWC-owned, manually entered — no QB source (migration 087,
            // backfilled from the "2026 Quote List" spreadsheet import).
            field({ name: 'engineer_name', order: 6, type: FieldTypes.STRING, default: '', required: false, label: 'Engineer', dbField: 'engineer_name', maxLength: 300, showOn: ['list', 'form'] }),
            // TBWC-owned lifecycle flag (migration 059) — written directly
            // via routes/quotes.ts's WRITABLE.
            field({
              name: 'status', order: 6, type: FieldTypes.SELECT, default: 'quote', required: false,
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
            field({ name: 'txn_date', order: 1, type: FieldTypes.DATE, default: null, required: false, label: 'Quote Date', dbField: 'txn_date', showOn: ['list', 'form'] }),
            // Migration 087 — same manually-entered, no-QB-source pattern as engineer_name.
            field({ name: 'po_date', order: 2, type: FieldTypes.DATE, default: null, required: false, label: 'PO Date', dbField: 'po_date', showOn: ['list', 'form'] }),
            field({ name: 'total', order: 3, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Total', dbField: 'total', showOn: ['list', 'form'] }),
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
            // No dbField write-back — rendered by QuoteForm's renderCustomField
            // as an editable add/remove grid (admin only) via framework's
            // PickableLineItemsGrid; reps see it read-only.
            field({
              name: 'lines', order: 1, type: FieldTypes.OBJECT, default: null, dbField: 'lines', showOn: ['form'],
              lineItemPicker: {
                // valueField is qb_item_id (qb_item's real PK) — not list_id,
                // which qb_item doesn't have; quote_line.qb_item_id (migration
                // 072) is what this ultimately writes to.
                itemSearch: { endpoint: '/inventory', valueField: 'qb_item_id', labelField: 'full_name' },
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
            // Rows live in public.document keyed by (entity_type='quote',
            // entity_id=<quote_id>).
            field({ name: 'documents', order: 1, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    quote_id: field({ name: 'quote_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'quote_id' }),
    // Not list/form-shown — options carrier for the list's rep filter, keyed
    // by list_id (mirrors orderSchema's sales_rep_list_id); injected at serve
    // time from public.qb_sales_rep (see routes/schema.ts).
    sales_rep_list_id: field({ name: 'sales_rep_list_id', type: FieldTypes.SELECT, default: null, readOnly: true, label: 'Sales Rep', dbField: 'sales_rep_list_id', enumValues: [] }),
  },
  validation: {},
});
