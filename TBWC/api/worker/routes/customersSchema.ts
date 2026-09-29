// ===== CUSTOMER schema (tbwc-site public.qb_customer) =====
// Served at GET /api/schema/customer. PK is `qb_customer_id` (bigint identity).
// Read-only: qb_customer is a QuickBooks staging mirror (pulled via CustomerQueryRq),
// so every field is readOnly and the module offers no create/edit/delete.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const customersSchema = defineSchema({
  entityName: 'Customer',
  tableName: 'qb_customer',
  idFieldName: 'qb_customer_id',
  description: 'QuickBooks customers (synced QB → TBWC, read-only)',
  formMaxWidth: '900px',
  customListColumns: {},
  defaultSortBy: 'full_name asc',

  formTabs: [
    tab({
      name: 'Customer',
      order: 1,
      sections: [
        section({
          name: 'Identity',
          order: 1,
          fields: [
            field({ name: 'full_name', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Name', dbField: 'full_name', maxLength: 500, showOn: ['list', 'form'] }),
            field({ name: 'company_name', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Company', dbField: 'company_name', maxLength: 500, showOn: ['list', 'form'] }),
            field({ name: 'first_name', order: 3, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'First Name', dbField: 'first_name', maxLength: 200, showOn: ['form'] }),
            field({ name: 'last_name', order: 4, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Last Name', dbField: 'last_name', maxLength: 200, showOn: ['form'] }),
            field({ name: 'is_active', order: 5, type: FieldTypes.BOOLEAN, default: true, required: false, readOnly: true, label: 'Active', dbField: 'is_active', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Contact',
          order: 2,
          fields: [
            field({ name: 'email', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Email', dbField: 'email', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'phone', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Phone', dbField: 'phone', maxLength: 100, showOn: ['list', 'form'] }),
            field({ name: 'balance', order: 3, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Balance', dbField: 'balance', showOn: ['list', 'form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    qb_customer_id: field({ name: 'qb_customer_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'qb_customer_id' }),
  },
  validation: {},
});
