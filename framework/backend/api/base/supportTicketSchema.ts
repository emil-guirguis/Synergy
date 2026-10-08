/**
 * Shared support-ticket form schema. Served at GET /api/schema/support_ticket
 * by each app's own schema.ts registry — drives the generic column/filter
 * generation in framework/frontend/support/SupportTicketList.tsx.
 * Table DDL: framework/backend/db/support_ticket.sql.
 */
// @ts-ignore - CommonJS module
const { defineSchema, field, tab, section, FieldTypes } = require('./SchemaDefinition');

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
            field({ name: 'serial_number', order: 5, type: FieldTypes.STRING, default: '', required: false, readOnly: false, label: 'Serial Number', dbField: 'serial_number', maxLength: 100, showOn: ['form'] }),
            field({ name: 'description', order: 6, type: FieldTypes.STRING, default: '',  required: false, readOnly: false, label: 'Description', dbField: 'description', showOn: ['form'] }),
            // Not support_ticket columns — joined from public.users in each
            // app's routes/support.ts (SELECT_WITH_USERS/JOIN_USERS), same
            // convention as invoicesSchema.ts's joined 'sales_rep'. List-only:
            // the detail page's own "Assigned To" dropdown edits
            // assigned_to_users_id directly, so this is a display column.
            field({ name: 'assigned_to_name', order: 7, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Assigned To', dbField: 'assigned_to_name', showOn: ['list'] }),
            // DATE not DATETIME: schemaColumnGenerator.ts's list-column
            // renderer only special-cases 'date' (formatDate) — 'datetime'
            // falls through to a raw String(value), showing the full ISO
            // timestamp. DATE still formats a full timestamp value fine
            // (formatDate just discards the time part).
            field({ name: 'created_at', order: 8, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Created', dbField: 'created_at', showOn: ['list'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Documents',
      order: 2,
      sections: [
        section({
          name: 'Documents',
          order: 1,
          fields: [
            // No dbField — UI-only anchor, same convention as invoicesSchema.ts.
            // The shared TicketDetailPage (framework/frontend/support) renders
            // the framework DocumentsGrid here; rows live in public.document
            // keyed by (entity_type='support_ticket', entity_id=<ticket id>).
            field({ name: 'documents', order: 1, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
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
