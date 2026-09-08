// @ts-ignore - CommonJS module
const { defineSchema, field, tab, section, FieldTypes } = require('@meterit/framework-backend/api/base/SchemaDefinition');

export const supportTicketSchema = defineSchema({
  entityName: 'Support Ticket',
  tableName: 'support_ticket',
  description: 'Support ticket entity',
  // `defaultSortBy` is the property name SchemaDefinition.js actually reads
  // (and serves at GET /api/schema/support-ticket) — `defaultSort` here was
  // silently dropped, same mismatch found and fixed in TBWC's orderSchema.ts.
  defaultSortBy: 'created_at',

  customListColumns: {},

  formTabs: [
    tab({
      name: 'General',
      order: 1,
      sections: [
        section({
          name: '',
          order: 1,
          flex: 1,
          fields: [
            field({ name: 'title',       order: 1, type: FieldTypes.STRING, default: '', required: true,  readOnly: false, label: 'Title',       dbField: 'title',    maxLength: 200, showOn: ['list', 'form'] }),
            field({ name: 'type',        order: 2, type: FieldTypes.STRING, default: 'general', required: false, readOnly: false, label: 'Type',   dbField: 'type',     enumValues: ['bug', 'feature_request', 'billing', 'account', 'technical', 'general'], showOn: ['list', 'form'] }),
            field({ name: 'status',      order: 3, type: FieldTypes.STRING, default: 'open',    required: false, readOnly: false, label: 'Status', dbField: 'status',   enumValues: ['open', 'in_progress', 'resolved', 'closed'], showOn: ['list', 'form'] }),
            field({ name: 'priority',    order: 4, type: FieldTypes.STRING, default: 'medium',  required: false, readOnly: false, label: 'Priority', dbField: 'priority', enumValues: ['low', 'medium', 'high', 'urgent'], showOn: ['list', 'form'] }),
            field({ name: 'description', order: 5, type: FieldTypes.STRING, default: '',  required: false, readOnly: false, label: 'Description', dbField: 'description', showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    support_ticket_id: field({ name: 'support_ticket_id', order: 1, type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'Id', dbField: 'support_ticket_id' }),
  },

  relationships: {},
  validation: {},
});
