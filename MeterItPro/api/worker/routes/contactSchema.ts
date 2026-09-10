// ===== CONTACT (from ContactWithSchema.js) =====
// @ts-ignore - CommonJS module
const { defineSchema, field, tab, section, FieldTypes } = require('@meterit/framework-backend/api/base/SchemaDefinition');
export const contactSchema = defineSchema({
  entityName: 'Contact',
  tableName: 'contact',
  description: 'Contact entity for customers, vendors, and other business contacts',
  formMaxWidth: '700px',

  customListColumns: {},

  formTabs: [
    tab({
      name: 'Contact',
      order: 1,
      sections: [
        section({
          name: 'Information',
          order: 1,
          flex: 1,
          minWidth: '300px',
          fields: [
            field({ name: 'name', order: 1, type: FieldTypes.STRING, default: '', required: true, label: 'Name', dbField: 'name', minLength: 2, maxLength: 100, placeholder: 'John Doe', showOn: ['list', 'form'] }),
            field({ name: 'company', order: 2, type: FieldTypes.STRING, default: '', required: false, label: 'Company', dbField: 'company', maxLength: 200, placeholder: 'Acme Corporation', showOn: ['list', 'form'] }),
            field({ name: 'role', order: 3, type: FieldTypes.STRING, default: '', required: false, label: 'Role', dbField: 'role', maxLength: 100, enumValues: ['Vendor', 'Customer', 'Contractor', 'Technician', 'Client', 'Sales Manager'], placeholder: 'Vendor', showOn: ['list', 'form'] }),
            field({ name: 'email', order: 4, type: FieldTypes.EMAIL, default: '', required: true, label: 'Email', dbField: 'email', maxLength: 254, pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$', placeholder: 'john@example.com', showOn: ['form'] }),
            field({ name: 'phone', order: 5, type: FieldTypes.PHONE, default: '', required: false, label: 'Phone', dbField: 'phone', maxLength: 50, placeholder: '() -', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Status',
          order: 2,
          maxWidth: '100px',
          flexGrow: 0,
          flexShrink: 0,
          fields: [
            field({ name: 'active', order: 1, type: FieldTypes.BOOLEAN, default: true, readOnly: false, label: 'Active', dbField: 'active', description: 'Whether the contact is active', showOn: ['list', 'form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Address',
      order: 2,
      sections: [
        section({
          name: 'Address Information',
          order: 1,
          fields: [
            field({ name: 'street', order: 1, type: FieldTypes.STRING, default: '', required: false, label: 'Street Address', dbField: 'street', maxLength: 200, placeholder: '123 Main St', showOn: ['form'] }),
            field({ name: 'street2', order: 2, type: FieldTypes.STRING, default: '', required: false, label: 'Street Address 2', dbField: 'street2', maxLength: 100, placeholder: 'Suite 100', showOn: ['form'] }),
            field({ name: 'city', order: 3, type: FieldTypes.STRING, default: '', required: false, label: 'City', dbField: 'city', maxLength: 100, placeholder: 'New York', showOn: ['form'] }),
            field({ name: 'state', order: 4, type: FieldTypes.STRING, default: '', required: false, label: 'State', dbField: 'state', maxLength: 50, placeholder: 'NY', showOn: ['form'] }),
            field({ name: 'zip', order: 5, type: FieldTypes.STRING, default: '', required: false, label: 'ZIP Code', dbField: 'zip', maxLength: 20, pattern: '^[0-9]{5}(-[0-9]{4})?$', placeholder: '10001', showOn: ['form'] }),
            field({ name: 'country', order: 6, type: FieldTypes.COUNTRY, default: 'US', required: false, label: 'Country', dbField: 'country', maxLength: 100, placeholder: 'USA', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Audit & Notes',
      order: 3,
      sectionOrientation: 'vertical',
      maxWidth: '200px',
      sections: [
        section({
          name: 'Notes',
          order: 1,
          fields: [
            field({ name: 'notes', order: 1, type: FieldTypes.STRING, default: '', required: false, label: 'Notes', dbField: 'notes', maxLength: 5000, placeholder: 'Additional notes...', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Audit',
          order: 2,
          fields: [
            field({ name: 'created_at', order: 1, type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Created At', dbField: 'created_at', showOn: ['form'] }),
            field({ name: 'updated_at', order: 2, type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Updated At', dbField: 'updated_at', showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    contact_id: field({ name: 'contact_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'contact_id' }),
    tenant_id: field({ name: 'tenant_id', type: FieldTypes.NUMBER, default: 0, readOnly: false, label: 'Tenant ID', dbField: 'tenant_id' }),
  },

  relationships: {},
  validation: {},

  deleteRestrictions: [
    { table: 'location', fk: 'contact_id', label: 'location' },
  ],
});
