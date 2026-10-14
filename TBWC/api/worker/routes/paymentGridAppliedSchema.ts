// ===== PAYMENT > APPLIED TO grid (qb_payment.applied_to jsonb) =====
// Served at GET /api/schema/paymentGridApplied. Read-only, QuickBooks-synced:
// which invoices a received payment was applied to. payments.ts applies
// paymentGridApplied:read to the payment's `applied_to`.
import {
  defineSchema,
  field,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const paymentGridAppliedSchema = defineSchema({
  entityName: 'Applied To',
  tableName: 'qb_payment',
  description: 'Invoices a payment was applied to (QuickBooks)',
  customListColumns: {},
  parent: { entity: 'payment', field: 'applied_to', label: 'Applied To', actions: ['read'] },

  formFields: {
    ref_number: field({ name: 'ref_number', order: 1, type: FieldTypes.STRING, default: null, readOnly: true, label: 'Ref #', showOn: ['list', 'form'] }),
    txn_type: field({ name: 'txn_type', order: 2, type: FieldTypes.STRING, default: null, readOnly: true, label: 'Type', showOn: ['list', 'form'] }),
    amount: field({ name: 'amount', order: 3, type: FieldTypes.CURRENCY, default: null, readOnly: true, label: 'Amount', showOn: ['list', 'form'] }),
  },
  entityFields: {},
  validation: {},
});
