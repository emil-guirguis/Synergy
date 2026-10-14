// ===== INVOICE > LINE ITEMS grid (qb_invoice.lines jsonb) =====
// Served at GET /api/schema/invoiceGridLine. Read-only, QuickBooks-synced —
// same shape and rules as orderGridLineSchema.ts (invoices.ts applies
// invoiceGridLine:read to the invoice's `lines`).
import {
  defineSchema,
  field,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const invoiceGridLineSchema = defineSchema({
  entityName: 'Invoice Line',
  tableName: 'qb_invoice',
  description: 'Invoice line items (QuickBooks)',
  customListColumns: {},
  parent: { entity: 'invoice', field: 'lines', label: 'Line Items', actions: ['read'] },

  formFields: {
    item: field({ name: 'item', order: 1, type: FieldTypes.STRING, default: null, readOnly: true, label: 'Item', showOn: ['list', 'form'] }),
    desc: field({ name: 'desc', order: 2, type: FieldTypes.TEXTAREA, default: null, readOnly: true, label: 'Description', showOn: ['list', 'form'] }),
    quantity: field({ name: 'quantity', order: 3, type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'Qty', showOn: ['list', 'form'] }),
    rate: field({ name: 'rate', order: 4, type: FieldTypes.CURRENCY, default: null, readOnly: true, label: 'Rate', showOn: ['list', 'form'] }),
    amount: field({ name: 'amount', order: 5, type: FieldTypes.CURRENCY, default: null, readOnly: true, label: 'Amount', showOn: ['list', 'form'] }),
  },
  entityFields: {},
  validation: {},
});
