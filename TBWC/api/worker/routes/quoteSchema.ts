// ===== QUOTE schema (tbwc-site public.quote) =====
// Served at GET /api/schema/quote. PK is `quote_id` (bigint identity).
// Line items live in public.quote_line and are edited via the custom QuoteForm,
// not this schema — this schema drives the list columns + header field metadata.
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
  description: 'TBWC price quote (header + line items)',
  formMaxWidth: '1100px',
  customListColumns: {},
  defaultSortBy: 'quote_number asc',

  formTabs: [
    tab({
      name: 'Quote',
      order: 1,
      sections: [
        section({
          name: 'Header',
          order: 1,
          fields: [
            field({ name: 'quote_number', order: 1, type: FieldTypes.STRING, default: '', required: false, label: 'Quote #', dbField: 'quote_number', maxLength: 100, showOn: ['list', 'form'] }),
            field({ name: 'project_name', order: 2, type: FieldTypes.STRING, default: '', required: false, label: 'Project', dbField: 'project_name', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'customer', order: 3, type: FieldTypes.STRING, default: '', required: false, label: 'Customer', dbField: 'customer', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'poc', order: 4, type: FieldTypes.STRING, default: '', required: false, label: 'POC', dbField: 'poc', maxLength: 200, showOn: ['form'] }),
            field({ name: 'cc_email', order: 5, type: FieldTypes.STRING, default: '', required: false, label: 'CC Email', dbField: 'cc_email', maxLength: 200, showOn: ['form'] }),
            field({ name: 'street_address', order: 6, type: FieldTypes.STRING, default: '', required: false, label: 'Street', dbField: 'street_address', maxLength: 300, showOn: ['form'] }),
            field({ name: 'city_state_zip', order: 7, type: FieldTypes.STRING, default: '', required: false, label: 'City, State ZIP', dbField: 'city_state_zip', maxLength: 300, showOn: ['form'] }),
            field({ name: 'status', order: 8, type: FieldTypes.SELECT, default: 'draft', required: false, label: 'Status', dbField: 'status', showOn: ['list', 'form'], options: [
              { value: 'draft', label: 'Draft' },
              { value: 'sent', label: 'Sent' },
              { value: 'won', label: 'Won' },
              { value: 'lost', label: 'Lost' },
            ] }),
            field({ name: 'rep', order: 9, type: FieldTypes.STRING, default: '', required: false, label: 'Rep', dbField: 'rep', maxLength: 200, showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Totals',
          order: 2,
          fields: [
            field({ name: 'subtotal', order: 1, type: FieldTypes.CURRENCY, default: 0, readOnly: true, required: false, label: 'Subtotal', dbField: 'subtotal', showOn: ['form'] }),
            field({ name: 'tax', order: 2, type: FieldTypes.CURRENCY, default: 0, required: false, label: 'Tax', dbField: 'tax', showOn: ['form'] }),
            field({ name: 'freight', order: 3, type: FieldTypes.CURRENCY, default: 0, required: false, label: 'Freight', dbField: 'freight', showOn: ['form'] }),
            field({ name: 'total', order: 4, type: FieldTypes.CURRENCY, default: 0, readOnly: true, required: false, label: 'Total', dbField: 'total', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Notes',
          order: 3,
          fields: [
            field({ name: 'notes', order: 1, type: FieldTypes.STRING, default: '', required: false, label: 'Notes', dbField: 'notes', maxLength: 5000, showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    quote_id: field({ name: 'quote_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'quote_id' }),
    rep_id: field({ name: 'rep_id', type: FieldTypes.STRING, default: null, readOnly: true, label: 'Rep ID', dbField: 'rep_id' }),
  },
  validation: {},
});
