
// ===== LOCATION (from LocationWithSchema.js) =====
import { defineSchema, field, tab, section, FieldTypes } from '@meterit/framework-backend/api/base/SchemaDefinition';

export const locationSchema = defineSchema({
  entityName: 'Location',
  tableName: 'location',
  description: 'Location entity',
  formMaxWidth: '700px',

  customListColumns: {},

  formTabs: [
    tab({
      name: 'General',
      order: 1,
      sections: [
        section({
          name: 'Details',
          order: 1,
          fields: [
            field({ name: 'name', order: 1, type: FieldTypes.STRING, default: '', required: true, label: 'Name', dbField: 'name', maxLength: 200, placeholder: 'Location', showOn: ['list', 'form'] }),
            field({ name: 'type', order: 2, type: FieldTypes.STRING, default: '', required: true, label: 'Type', dbField: 'type', maxLength: 20, enumValues: ['Warehouse', 'Apartment', 'Office', 'Retail', 'Hotel', 'Building', 'Other'], placeholder: 'Warehouse', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Address',
          order: 2,
          fields: [
            field({ name: 'street', order: 1, type: FieldTypes.STRING, default: '', required: true, label: 'Street', dbField: 'street', maxLength: 200, placeholder: '1234 Street', showOn: ['form'] }),
            field({ name: 'street2', order: 2, type: FieldTypes.STRING, default: '', required: false, label: 'Street2', dbField: 'street2', maxLength: 100, placeholder: 'Unit A', showOn: ['form'] }),
            field({ name: 'city', order: 3, type: FieldTypes.STRING, default: '', required: true, label: 'City', dbField: 'city', maxLength: 100, placeholder: 'City', showOn: ['form'] }),
            field({ name: 'state', order: 4, type: FieldTypes.STRING, default: '', required: true, label: 'State', dbField: 'state', maxLength: 50, placeholder: 'State', showOn: ['form'] }),
            field({ name: 'zip', order: 5, type: FieldTypes.STRING, default: '', required: true, label: 'Zip', dbField: 'zip', placeholder: 'Zip', showOn: ['form'], maxLength: 20 }),
            field({ name: 'country', order: 6, type: FieldTypes.COUNTRY, default: '', required: true, label: 'Country', dbField: 'country', maxLength: 100, placeholder: 'USA', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Status',
          order: 3,
          maxWidth: '100px',
          flexGrow: 0,
          flexShrink: 0,
          fields: [
            field({ name: 'active', order: 2, type: FieldTypes.BOOLEAN, default: true, required: false, label: 'Active', dbField: 'active', showOn: ['list', 'form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Audit & Notes',
      order: 2,
      sectionOrientation: 'vertical',
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
          maxWidth: '200px',
          order: 2,
          fields: [
            field({ name: 'created_at', order: 1, type: FieldTypes.DATETIME, default: null, disable: true, label: 'Created At', dbField: 'created_at', showOn: ['form'] }),
            field({ name: 'updated_at', order: 2, type: FieldTypes.DATETIME, default: null, disable: true, label: 'Updated At', dbField: 'updated_at', showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    location_id: field({ name: 'location_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'Id', dbField: 'location_id' }),
    tenant_id: field({ name: 'tenant_id', type: FieldTypes.NUMBER, default: null, readOnly: false, label: 'Tenant ID', dbField: 'tenant_id' }),
  },

  validation: {},

  deleteRestrictions: [
    { table: 'meter', fk: 'location_id', label: 'meter' },
  ],
});
