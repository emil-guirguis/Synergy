/**
 * Shared support-ticket form schema. Served at GET /api/schema/support_ticket
 * by each app's own schema.ts registry — drives the generic column/filter
 * generation in framework/frontend/support/SupportTicketList.tsx, and (via
 * framework/frontend/support/SupportTicketForm.tsx) the BaseForm-rendered
 * create/edit form itself, same as every other module's schema.
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
  // Drives EntityManagementPage's modal crumb ("Edit Support Ticket TK-000123"),
  // same convention as orderSchema.ts's titleField: 'ref_number'.
  titleField: 'ticket_number',

  customListColumns: {},

  formTabs: [
    tab({
      name: 'Ticket Info',
      order: 1,
      sections: [
        section({
          name: '',
          order: 1,
          flex: 1,
          fields: [
            // Not a support_ticket column — computed as 'TK-NNNNNN' off
            // support_ticket_id in each app's routes/support.ts SELECT, same
            // zero-extra-column reasoning as assigned_to_name below. readOnly:
            // it's a display id, not something a filer or admin ever edits.
            field({ name: 'ticket_number', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Ticket #', dbField: 'ticket_number', showOn: ['list', 'form'] }),
            field({ name: 'title',       order: 2, type: FieldTypes.STRING,   default: '', required: true,  readOnly: false, label: 'Title',       dbField: 'title',    maxLength: 200, showOn: ['list', 'form'] }),
            // enumLabels only overrides 'rma' — every other value already reads fine
            // through BaseForm's generic "split on _, capitalize each word" fallback.
            field({ name: 'type',        order: 3, type: FieldTypes.STRING,   default: 'general', required: false, readOnly: false, label: 'Type',   dbField: 'type',     enumValues: ['bug', 'feature_request', 'billing', 'account', 'technical', 'general', 'rma'], enumLabels: { rma: 'RMA' }, showOn: ['list', 'form'] }),
            field({ name: 'description', order: 4, type: FieldTypes.TEXTAREA, default: '',  required: false, readOnly: false, label: 'Description', dbField: 'description', rows: 5, showOn: ['form'] }),
            // Not a support_ticket column — joined from public.users (routes/
            // support.ts SELECT_WITH_USERS/JOIN_USERS), same convention as
            // invoicesSchema.ts's joined 'sales_rep'. List-column counterpart
            // of assigned_to_users_id below (the real, editable FK) — kept out
            // of the FORM via SupportTicketForm's excludeFields, since BaseForm
            // doesn't gate fields by showOn itself (only the list/filter
            // generator reads it); without the exclude this field and
            // assigned_to_users_id would both render as two "Assigned To"
            // controls.
            field({ name: 'assigned_to_name', order: 5, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Assigned To', dbField: 'assigned_to_name', showOn: ['list'] }),
          ],
        }),
        section({
          // Status/priority grouped with the open/close timestamps and who
          // owns it — this is "where things stand on this ticket right now".
          name: 'Status & Dates',
          order: 2,
          flex: 1,
          fields: [
            // visibleFor: meaningless at creation (every new ticket starts
            // 'open', unowned) — shown read-only to a filer once the ticket
            // exists (SupportTicketForm's variant is 'filer-view' then, never
            // for a brand-new one), and editable for admin always. See
            // SupportTicketForm.tsx's variant computation.
            field({ name: 'status', order: 1, type: FieldTypes.STRING, default: 'open', required: false, readOnly: false, label: 'Status', dbField: 'status', enumValues: ['open', 'in_progress', 'resolved', 'closed'], visibleFor: ['admin', 'filer-view'], showOn: ['list', 'form'] }),
            field({ name: 'priority', order: 2, type: FieldTypes.STRING, default: 'medium', required: false, readOnly: false, label: 'Priority', dbField: 'priority', enumValues: ['low', 'medium', 'high', 'urgent'], showOn: ['list', 'form'] }),
            // SELECT with empty enumValues, populated server-side at schema-
            // serve time (TBWC: routes/schema.ts's assignableUserOptions) —
            // same pattern as usersSchema.ts's qb_sales_rep_id. Not scoped by
            // tenant_id/support:write here; each app's schema.ts route decides
            // who's assignable. This is the ONE "Assigned To" control that
            // actually renders on the form — see assigned_to_name's comment above.
            field({ name: 'assigned_to_users_id', order: 3, type: FieldTypes.SELECT, default: null, required: false, readOnly: false, label: 'Assigned To', dbField: 'assigned_to_users_id', enumValues: [], placeholder: '— Unassigned —', visibleFor: ['admin', 'filer-view'], showOn: ['form'] }),
            // DATE (not DATETIME) so schemaColumnGenerator.ts's list-column
            // renderer formats it with formatDate — kept out of the FORM via
            // excludeFields (see assigned_to_name's comment above); 'opened_at'
            // below is the one that actually renders there, since DATE would
            // truncate the time.
            field({ name: 'created_at', order: 4, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Opened', dbField: 'created_at', showOn: ['list'] }),
            // Same dbField as created_at above — a second schema field purely
            // so the form can render it as DATETIME (full date+time) while the
            // list column stays DATE. BaseForm maps by dbField->apiField, not
            // by field name, so two fields safely read the same column.
            field({ name: 'opened_at', order: 5, type: FieldTypes.DATETIME, default: null, required: false, readOnly: true, label: 'Opened', dbField: 'created_at', showOn: ['form'] }),
            // Set automatically by routes/support.ts on a resolved/closed
            // status transition — never written directly by the client, so
            // this is a read-only display field. DATETIME: "closed" without a
            // time is next to useless for SLA/turnaround tracking.
            field({ name: 'resolved_at', order: 6, type: FieldTypes.DATETIME, default: null, required: false, readOnly: true, label: 'Closed', dbField: 'resolved_at', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      // Filer contact info — required so support can actually reach whoever
      // filed the ticket without having to dig through the users table (a
      // ticket may be filed on a shared/front-desk login). Not the caller's
      // own account name/phone necessarily.
      name: 'Contact Info',
      order: 2,
      sections: [
        section({
          name: '',
          order: 1,
          flex: 1,
          fields: [
            field({ name: 'contact_name',  order: 1, type: FieldTypes.STRING, default: '', required: true,  readOnly: false, label: 'Contact Name',  dbField: 'contact_name',  maxLength: 200, showOn: ['list', 'form'] }),
            field({ name: 'contact_phone', order: 2, type: FieldTypes.PHONE,  default: '', required: true,  readOnly: false, label: 'Contact Phone', dbField: 'contact_phone', maxLength: 30,  showOn: ['form'] }),
            field({ name: 'contact_email', order: 3, type: FieldTypes.EMAIL,  default: '', required: false, readOnly: false, label: 'Contact Email', dbField: 'contact_email', maxLength: 200, showOn: ['form'] }),
            field({ name: 'job_name',      order: 4, type: FieldTypes.STRING, default: '', required: false, readOnly: false, label: 'Job Name',      dbField: 'job_name',      showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Order / Invoice Reference',
      order: 3,
      sections: [
        section({
          // po_number is checked against the app's own orders table on entry
          // (TBWC: GET /support/validate-po/:po) — not a DB FK, since a filer
          // may type a PO before TBWC's own order record exists. serial_number
          // drives the app's "find invoices mentioning this serial" lookup
          // (real invoices only — packing slips are excluded server-side).
          name: '',
          order: 1,
          flex: 1,
          fields: [
            field({ name: 'po_number',      order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: false, label: 'PO Number',      dbField: 'po_number',      maxLength: 100, showOn: ['list', 'form'] }),
            field({ name: 'order_number',   order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: false, label: 'Order Number',   dbField: 'order_number',   maxLength: 100, showOn: ['form'] }),
            field({ name: 'invoice_number', order: 3, type: FieldTypes.STRING, default: '', required: false, readOnly: false, label: 'Invoice Number', dbField: 'invoice_number', maxLength: 100, showOn: ['form'] }),
            field({ name: 'serial_number',  order: 4, type: FieldTypes.STRING, default: '', required: false, readOnly: false, label: 'Serial Number',  dbField: 'serial_number',  maxLength: 100, showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      // Hidden outright (not just disabled) while a filer is filing a brand-
      // new ticket — there's nothing to resolve yet. Visible once it exists
      // (SupportTicketForm's 'filer-view' variant) so the filer can read how
      // it was resolved, and always visible for admin.
      name: 'Resolution',
      order: 4,
      visibleFor: ['admin', 'filer-view'],
      sections: [
        section({
          // Admin-only in practice: the whole PUT route is support:write-gated
          // (routes/support.ts), and SupportTicketForm disables the whole form
          // for a non-admin viewer (same read-only-viewer convention OrderForm
          // uses for a non-admin rep).
          name: 'Resolution Memo',
          order: 1,
          flex: 1,
          fields: [
            field({ name: 'resolution_notes', order: 1, type: FieldTypes.TEXTAREA, default: '', required: false, readOnly: false, label: 'Resolution Memo', dbField: 'resolution_notes', rows: 4, visibleFor: ['admin', 'filer-view'], showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Documents',
      order: 5,
      sections: [
        section({
          name: 'Documents',
          order: 1,
          fields: [
            // No dbField — UI-only anchor, same convention as invoicesSchema.ts.
            // SupportTicketForm (framework/frontend/support) renders the
            // framework DocumentsGrid here; rows live in public.document
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
