// ===== USER (from UserWithSchema.js) =====
import { defineSchema, field, tab, section, FieldTypes, relationship, RelationshipTypes } from '@meterit/framework-backend/api/base/SchemaDefinition';

export const userSchema = defineSchema({
  entityName: 'User',
  tableName: 'users',
  description: 'User entity for authentication and authorization',
  formMaxWidth: '700px',

  customListColumns: {},

  formTabs: [
    tab({
      name: 'General',
      order: 1,
      sections: [
        section({
          name: 'Information',
          order: 1,
          fields: [
            field({ name: 'name', order: 1, type: FieldTypes.STRING, default: '', required: true, label: 'Name', dbField: 'name', maxLength: 100, placeholder: 'John Doe', showOn: ['list', 'form'] }),
            field({ name: 'email', order: 2, type: FieldTypes.EMAIL, default: '', required: true, label: 'Email', dbField: 'email', maxLength: 254, placeholder: 'email@yahoo.com', showOn: ['list', 'form'] }),
            field({ name: 'phone', order: 3, type: FieldTypes.PHONE, default: '', required: true, label: 'Phone', dbField: 'phone', maxLength: 20, placeholder: '(xxx) xxx-xxxx', showOn: ['list', 'form'] }),
            field({ name: 'password', order: 3, type: 'password', default: '', required: true, label: 'Password', dbField: 'password', maxLength: 200, placeholder: '********', showOn: ['form'] }),
            field({ name: 'role', order: 4, type: FieldTypes.STRING, default: 'viewer', required: false, label: 'Role', dbField: 'role', maxLength: 20, enumValues: ['superadmin', 'supersupport', 'adminsupport', 'admin', 'manager', 'technician', 'viewer', 'user'], placeholder: 'viewer', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Status',
          order: 2,
          maxWidth: '100px',
          flexGrow: 0,
          flexShrink: 0,
          fields: [
            field({ name: 'active', order: 1, type: FieldTypes.BOOLEAN, default: true, required: false, label: 'Active', dbField: 'active', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Admin Access',
          order: 3,
          maxWidth: '160px',
          flexGrow: 0,
          flexShrink: 0,
          fields: [
            field({ name: 'is_super_admin',   order: 1, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Super Admin',   dbField: 'is_super_admin',   showOn: ['form'] }),
            field({ name: 'is_support_admin', order: 2, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Support Admin', dbField: 'is_support_admin', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Security',
      order: 2,
      sections: [
        section({
          name: 'Permissions',
          order: 1,
          maxWidth: '400px',
          fields: [
            field({ name: 'permissions', order: 1, type: FieldTypes.JSON, default: {}, required: false, label: '', dbField: 'permissions', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Password Reset',
          order: 2,
          maxWidth: '200px',
          fields: [
            field({ name: 'password_reset_actions', order: 1, type: FieldTypes.STRING, default: '', required: false, label: 'Password Management', dbField: '', readOnly: true, showOn: ['form'], description: 'Actions for managing user password' }),
            field({ name: 'password_reset_token', order: 2, type: FieldTypes.STRING, default: '', required: false, label: 'Reset Token', dbField: '', maxLength: 200, readOnly: true, showOn: ['form'], placeholder: 'No active reset', description: 'Active password reset token if one exists' }),
            field({ name: 'password_reset_expires_at', order: 3, type: FieldTypes.DATETIME, default: null, required: false, label: 'Token Expires', dbField: '', readOnly: true, showOn: ['form'], placeholder: 'No expiration', description: 'When the reset token expires' }),
          ],
        }),
        section({
          name: 'Impersonate',
          order: 3,
          maxWidth: '200px',
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
  ],

  entityFields: {
    users_id: field({ name: 'users_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'users_id' }),
    tenant_id: field({ name: 'tenant_id', type: FieldTypes.NUMBER, default: null, readOnly: false, label: 'Tenant ID', dbField: 'tenant_id' }),
    passwordHash: field({ name: 'passwordHash', type: FieldTypes.STRING, default: '', required: false, label: 'Password Hash', dbField: 'passwordhash', maxLength: 200, readOnly: true }),
    createdAt: field({ name: 'createdAt', type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Created At', dbField: 'created_at' }),
    updatedAt: field({ name: 'updatedAt', type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Updated At', dbField: 'updated_at' }),
    lastLogin: field({ name: 'lastLogin', type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Last Login', dbField: 'last_login_at' }),
    passwordChangedAt: field({ name: 'passwordChangedAt', type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Password Changed At', dbField: 'password_changed_at' }),
    failedLoginAttempts: field({ name: 'failedLoginAttempts', type: FieldTypes.NUMBER, default: 0, readOnly: false, label: 'Failed Login Attempts', dbField: 'failed_login_attempts' }),
    lockedUntil: field({ name: 'lockedUntil', type: FieldTypes.DATETIME, default: null, readOnly: false, label: 'Locked Until', dbField: 'locked_until' }),
  },

  relationships: {
    tenant: relationship({
      type: RelationshipTypes.BELONGS_TO,
      model: 'Tenant',
      foreignKey: 'tenant_id',
      autoLoad: false,
    }),
  },

  validation: {},

  deleteRestrictions: [
    { table: 'support_ticket', fk: 'users_id', label: 'support ticket' },
    { table: 'dashboard', fk: 'users_id', label: 'dashboard' },
  ],
});
