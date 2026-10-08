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
  defaultSortBy: 'first_name asc',

  formTabs: [
    tab({
      name: 'Profile',
      order: 1,
      // Two visual columns: Identity fills the left half (spanning every row);
      // the right half stacks Agency (full width) over Details.
      // The trailing 1fr row absorbs Identity's extra height so Details sits
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
            // enumValues/enumLabels are injected at serve time from public.role
            // (see schema route).
            field({ name: 'role_id', order: 5, type: FieldTypes.SELECT, default: null, required: true, label: 'Role', dbField: 'role_id', enumValues: [], showOn: ['list', 'form'] }),
            // enumValues/enumLabels are injected at serve time from public.qb_sales_rep
            // (see schema route). Stores the qb_sales_rep_id FK; blank = not linked.
            field({ name: 'qb_sales_rep_id', order: 6, type: FieldTypes.SELECT, default: null, required: false, label: 'QB Sales Rep', dbField: 'qb_sales_rep_id', enumValues: [], placeholder: '— Not linked —', showOn: ['list','form'] }),
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
          gridColumn: '2 / 4',
          gridRow: '2',
          fields: [
            field({ name: 'is_admin', order: 1, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Admin', dbField: 'is_admin', showOn: ['form'] }),
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
            field({ name: 'approved', order: 2, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Approved', dbField: 'approved', showOn: [ 'form'] }),
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
        section({
          name: 'Impersonate',
          order: 3,
          fields: [
            // UI-only — rendered by UserForm.tsx's renderCustomField as
            // ImpersonateButton (framework/frontend/components/auth), not a
            // real column. Dev-only, single-email gated; invisible to anyone
            // else even though the field is served to every caller.
            field({ name: 'impersonate_actions', order: 1, type: FieldTypes.STRING, default: '', required: false, label: '', dbField: '', readOnly: true, showOn: ['form'], description: 'Dev-only: log in as this user to test their account.' }),
          ],
        }),

      ],
    }),
    tab({
      name: 'Manages',
      order: 4,
      // Admin-only (the Users module is admin-only end to end — see users.ts),
      // which is exactly what we want: this is the only place the flat
      // public.user_manager relation gets configured. Orders.ts's ownOnly
      // scoping then unions the picked users' QB rep identity into the
      // logged-in manager's own order visibility.
      sections: [
        section({
          name: 'Manages',
          order: 1,
          fields: [
            // UI-only — rendered by UserForm.tsx's renderCustomField as
            // ManagedUsersGrid, not a real column (see 'documents'/'lines' on
            // other forms for the same pattern). Saves itself row-by-row via
            // /api/user-managers, independent of this form's Save button.
            field({ name: 'managed_users', order: 1, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Preferences',
      order: 5,
      sections: [
        section({
          name: 'Preferences',
          order: 1,
          fields: [
            // Admin-editable per-user override of the same columns the header's
            // self-service Preferences form writes (public.users, migration
            // 077). Blank = inherit the system default from Settings > System
            // Config. Real columns on this form's own row, so the form's
            // ordinary Save/Cancel covers them — no separate save needed.
            field({ name: 'timezone', order: 1, type: FieldTypes.TIMEZONE, default: null, required: false, label: 'Timezone', dbField: 'timezone', placeholder: '(system default)', showOn: ['form'] }),
            field({
              name: 'date_format', order: 2, type: FieldTypes.SELECT, default: null, required: false,
              label: 'Date Format', dbField: 'date_format', placeholder: '(system default)', showOn: ['form'],
              enumValues: ['mm/dd/yyyy', 'dd/mm/yyyy', 'yyyy-mm-dd', 'dd-mm-yyyy', 'mm-dd-yyyy', 'dd.mm.yyyy', 'mmmm d, yyyy'],
              enumLabels: {
                'mm/dd/yyyy': 'MM/DD/YYYY', 'dd/mm/yyyy': 'DD/MM/YYYY', 'yyyy-mm-dd': 'YYYY-MM-DD',
                'dd-mm-yyyy': 'DD-MM-YYYY', 'mm-dd-yyyy': 'MM-DD-YYYY', 'dd.mm.yyyy': 'DD.MM.YYYY — European',
                'mmmm d, yyyy': 'Month D, YYYY',
              },
            }),
            field({
              name: 'time_format', order: 3, type: FieldTypes.SELECT, default: null, required: false,
              label: 'Time Format', dbField: 'time_format', placeholder: '(system default)', showOn: ['form'],
              enumValues: ['12h', '24h'],
              enumLabels: { '12h': '12-hour', '24h': '24-hour' },
            }),
            field({
              name: 'default_page_size', order: 4, type: FieldTypes.SELECT, default: null, required: false,
              label: 'Default Page Size', dbField: 'default_page_size', placeholder: '(system default)', showOn: ['form'],
              enumValues: [10, 25, 50, 100],
              enumLabels: { 10: '10', 25: '25', 50: '50', 100: '100' },
            }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Notes',
      order: 6,
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
