// ===== USER schema (tbwc-site public.users) =====
// Served at GET /api/schema/user. Drives the framework list + form, exactly
// like MeterItPro's *Schema.ts files. PK is `id` (uuid) — idFieldName tells the
// framework which column carries the id.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const usersSchema = defineSchema({
  entityName: 'User',
  tableName: 'users',
  idFieldName: 'id',
  description: 'Rep portal user profile (tbwc-site public.users)',
  formMaxWidth: '760px',
  customListColumns: {},

  formTabs: [
    tab({
      name: 'Profile',
      order: 1,
      // Two visual columns: Identity fills the left half (spanning every row);
      // the right half stacks Agency (full width) over Details | QuickBooks.
      // The trailing 1fr row absorbs Identity's extra height so Details/QB sit
      // directly under Agency instead of being pushed down.
      columns: '2fr 1fr 1fr',
      rows: 'auto auto 1fr',
      sections: [
        section({
          name: 'Identity',
          order: 1,
          gridColumn: '1',
          gridRow: '1 / 4',
          fields: [
            field({ name: 'first_name', order: 1, type: FieldTypes.STRING, default: '', required: true, label: 'First Name', dbField: 'first_name', maxLength: 100, placeholder: 'Jane', showOn: ['list', 'form'] }),
            field({ name: 'last_name', order: 2, type: FieldTypes.STRING, default: '', required: true, label: 'Last Name', dbField: 'last_name', maxLength: 100, placeholder: 'Doe', showOn: ['list', 'form'] }),
            field({ name: 'email', order: 3, type: FieldTypes.EMAIL, default: '', required: true, label: 'Email', dbField: 'email', maxLength: 254, placeholder: 'jane@agency.com', showOn: ['list', 'form'] }),
            field({ name: 'title', order: 4, type: FieldTypes.STRING, default: '', required: false, label: 'Title', dbField: 'title', maxLength: 100, placeholder: 'Sales Rep', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Agency',
          order: 2,
          gridColumn: '2 / 4',
          gridRow: '1',
          fields: [
            field({ name: 'agency_name', order: 1, type: FieldTypes.STRING, default: '', required: false, label: 'Agency', dbField: 'agency_name', maxLength: 200, placeholder: 'Acme Reps', showOn: ['list', 'form'] }),
            field({ name: 'url', order: 2, type: FieldTypes.URL, default: '', required: false, label: 'Website', dbField: 'url', maxLength: 300, placeholder: 'https://…', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Details',
          order: 3,
          gridColumn: '2',
          gridRow: '2',
          fields: [
            field({ name: 'type', order: 1, type: FieldTypes.STRING, default: 'rep', required: true, label: 'Type', dbField: 'type', enumValues: ['rep', 'customer', 'employee'], showOn: ['list', 'form'] }),
            field({ name: 'is_admin', order: 2, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Admin', dbField: 'is_admin', showOn: ['list', 'form'] }),
         ],
        }),
        section({
          name: 'QuickBooks',
          order: 4,
          gridColumn: '3',
          gridRow: '2',
          fields: [
            // enumValues/enumLabels are injected at serve time from public.qb_sales_rep
            // (see schema route). Stores the qb_sales_rep_id FK; blank = not linked.
            field({ name: 'qb_sales_rep_id', order: 1, type: FieldTypes.SELECT, default: null, required: false, label: 'QB Sales Rep', dbField: 'qb_sales_rep_id', enumValues: [], placeholder: '— Not linked —', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Contact',
      order: 2,
      sections: [
        section({
          name: 'Phone',
          order: 1,
          fields: [
            field({ name: 'work_phone', order: 1, type: FieldTypes.PHONE, default: '', required: false, label: 'Work Phone', dbField: 'work_phone', maxLength: 50, showOn: ['form'] }),
            field({ name: 'ext', order: 2, type: FieldTypes.STRING, default: '', required: false, label: 'Ext', dbField: 'ext', maxLength: 20, showOn: ['form'] }),
            field({ name: 'mobile', order: 3, type: FieldTypes.PHONE, default: '', required: false, label: 'Mobile', dbField: 'mobile', maxLength: 50, showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Address',
          order: 2,
          fields: [
            field({ name: 'addr1', order: 1, type: FieldTypes.STRING, default: '', required: false, label: 'Address 1', dbField: 'addr1', maxLength: 200, showOn: ['form'] }),
            field({ name: 'addr2', order: 2, type: FieldTypes.STRING, default: '', required: false, label: 'Address 2', dbField: 'addr2', maxLength: 100, showOn: ['form'] }),
            field({ name: 'city', order: 3, type: FieldTypes.STRING, default: '', required: false, label: 'City', dbField: 'city', maxLength: 100, showOn: ['form'] }),
            field({ name: 'state', order: 4, type: FieldTypes.STRING, default: '', required: false, label: 'State', dbField: 'state', maxLength: 50, showOn: ['form'] }),
            field({ name: 'postal', order: 5, type: FieldTypes.STRING, default: '', required: false, label: 'Postal', dbField: 'postal', maxLength: 20, showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Security',
      order: 3,
      sections: [
        section({
          name: 'Role & Approval',
          order: 1,
          fields: [
            field({ name: 'approved', order: 2, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Approved', dbField: 'approved', showOn: ['list', 'form'] }),
            field({ name: 'can_approve_rep_leads', order: 5, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Approve Rep Leads', dbField: 'can_approve_rep_leads', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Re-verification',
          order: 2,
          readOnly: true,
          fields: [
            // Set by the 90-day cron (worker/reverification.ts) when a rep
            // goes stale; cleared when they click the mailed verify link.
            field({ name: 'locked_at', order: 1, type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Locked At', dbField: 'locked_at', showOn: ['list', 'form'] }),
            field({ name: 'last_verified_at', order: 2, type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Last Verified', dbField: 'last_verified_at', showOn: ['form'] }),
          ],
        }),

      ],
    }),
    tab({
      name: 'Notes',
      order: 4,
      sections: [
        section({
          name: 'Notes',
          order: 1,
          fields: [
            field({ name: 'about', order: 1, type: FieldTypes.TEXTAREA, default: '', required: false, label: 'About', dbField: 'about', maxLength: 5000, showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    id: field({ name: 'id', type: FieldTypes.STRING, default: null, readOnly: true, label: 'ID', dbField: 'id' }),
    created_at: field({ name: 'created_at', type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Created', dbField: 'created_at' }),
  },
  validation: {},
});
