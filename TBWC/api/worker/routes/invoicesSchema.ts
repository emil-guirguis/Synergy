// ===== INVOICE schema (tbwc-site public.qb_invoice) =====
// Served at GET /api/schema/invoice. PK is `qb_invoice_id` (bigint identity).
// Read-only: qb_invoice is a QuickBooks staging mirror (pulled via InvoiceQueryRq),
// so every field is readOnly and the module offers no create/edit/delete.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const invoicesSchema = defineSchema({
  entityName: 'Invoice',
  tableName: 'qb_invoice',
  idFieldName: 'qb_invoice_id',
  description: 'QuickBooks invoices (synced QB → TBWC, read-only)',
  formMaxWidth: '900px',
  customListColumns: {},

  formTabs: [
    tab({
      name: 'Invoice',
      order: 1,
      sections: [
        section({
          name: 'Identity',
          order: 1,
          fields: [
            field({ name: 'ref_number', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Invoice #', dbField: 'ref_number', maxLength: 50, showOn: ['list', 'form'] }),
            field({ name: 'customer_name', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Customer', dbField: 'customer_name', maxLength: 500, showOn: ['list', 'form'] }),
            field({ name: 'txn_date', order: 3, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Invoice Date', dbField: 'txn_date', showOn: ['list', 'form'] }),
            field({ name: 'due_date', order: 4, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Due Date', dbField: 'due_date', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Totals',
          order: 2,
          fields: [
            field({ name: 'subtotal', order: 1, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Subtotal', dbField: 'subtotal', showOn: ['form'] }),
            field({ name: 'total', order: 2, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Total', dbField: 'total', showOn: ['list', 'form'] }),
            field({ name: 'balance_remaining', order: 3, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Balance', dbField: 'balance_remaining', showOn: ['list', 'form'] }),
            field({ name: 'is_paid', order: 4, type: FieldTypes.BOOLEAN, default: false, required: false, readOnly: true, label: 'Paid', dbField: 'is_paid', showOn: ['list', 'form'] }),
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
            field({ name: 'lines', order: 1, type: FieldTypes.JSON, default: null, required: false, readOnly: true, label: 'Lines', dbField: 'lines', showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    qb_invoice_id: field({ name: 'qb_invoice_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'qb_invoice_id' }),
  },
  validation: {},
});
