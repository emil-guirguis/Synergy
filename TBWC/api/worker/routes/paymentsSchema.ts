// ===== PAYMENT schema (tbwc-site public.qb_payment) =====
// Served at GET /api/schema/payment. PK is `qb_payment_id` (bigint identity).
// Read-only: qb_payment is a QuickBooks staging mirror (pulled via
// ReceivePaymentQueryRq), so every field is readOnly and the module offers no
// create/edit/delete. This is the AR side of the sync — see qbwc/objects/payment.ts.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const paymentsSchema = defineSchema({
  entityName: 'Payment',
  tableName: 'qb_payment',
  idFieldName: 'qb_payment_id',
  description: 'QuickBooks customer payments (synced QB → TBWC, read-only)',
  formMaxWidth: '900px',
  customListColumns: {},
  defaultSortBy: 'txn_date desc',

  formTabs: [
    tab({
      name: 'Payment',
      order: 1,
      sections: [
        section({
          name: 'Identity',
          order: 1,
          fields: [
            field({ name: 'ref_number', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Ref #', dbField: 'ref_number', maxLength: 50, showOn: ['list', 'form'] }),
            field({ name: 'customer_name', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Customer', dbField: 'customer_name', maxLength: 500, showOn: ['list', 'form'] }),
            field({ name: 'txn_date', order: 3, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Date', dbField: 'txn_date', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Amounts',
          order: 2,
          fields: [
            field({ name: 'total_amount', order: 1, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Amount', dbField: 'total_amount', showOn: ['list', 'form'] }),
            field({ name: 'unapplied_amount', order: 2, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Unapplied', dbField: 'unapplied_amount', showOn: ['list', 'form'] }),
            // Which invoice(s) this payment was applied to — [{txn_id, txn_type, ref_number, amount}].
            field({ name: 'applied_to', order: 3, type: FieldTypes.JSON, default: null, required: false, readOnly: true, label: 'Applied To', dbField: 'applied_to', showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    qb_payment_id: field({ name: 'qb_payment_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'qb_payment_id' }),
  },
  validation: {},
});
