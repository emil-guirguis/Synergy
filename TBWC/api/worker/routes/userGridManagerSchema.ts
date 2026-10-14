// ===== USER > MANAGES grid (tbwc-site public.user_manager, migration 061) =====
// Served at GET /api/schema/userGridManager. PK is `user_manager_id`.
// Child-row grid on the Users form's "Manages" tab — who this user's order
// list also covers (orders.ts unions sales_rep_list_id across the set; flat,
// one level). Rows are add/remove only: changing who a row points at means
// removing it and adding another, so no `write` action. Routes:
// routes/userManagers.ts -> framework childRows.ts.
import {
  defineSchema,
  field,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const userGridManagerSchema = defineSchema({
  entityName: 'Managed User',
  tableName: 'user_manager',
  idFieldName: 'user_manager_id',
  description: 'Users this user manages',
  customListColumns: {},
  parent: { entity: 'user', foreignKey: 'manager_id', label: 'Manages', actions: ['read', 'create', 'delete'] },

  formFields: {
    managed_user_id: field({
      name: 'managed_user_id', order: 1, type: FieldTypes.SELECT, default: null, required: true,
      label: 'User', dbField: 'managed_user_id', showOn: ['list', 'form'],
      // /users list items carry first/last name separately — the label joins them.
      referenceSearch: { endpoint: '/users', valueField: 'id', labelField: ['first_name', 'last_name'], displayField: 'managed_user_name' },
    }),
    // Display-only (no dbField): joined in by userManagers.ts's select.
    email: field({ name: 'email', order: 2, type: FieldTypes.STRING, default: null, readOnly: true, label: 'Email', showOn: ['list', 'form'] }),
    sales_rep_initial: field({ name: 'sales_rep_initial', order: 3, type: FieldTypes.STRING, default: null, readOnly: true, label: 'Sales Rep', showOn: ['list', 'form'] }),
  },

  entityFields: {
    user_manager_id: field({ name: 'user_manager_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'user_manager_id' }),
  },
  validation: {},
});
